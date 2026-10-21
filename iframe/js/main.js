let stopped = false;

const NET_NAME = 'HILBERT';
const LAYER_TOP = 1;
const LAYER_BOTTOM = 2;

/** 铜在 20℃ 的电阻率，Ω·mm²/m */
const RHO_20 = 0.01724;
/** 铜的电阻温度系数，1/℃ */
const ALPHA = 0.00393;

function stopDrawing() {
	stopped = true;
}

/**
 * 计算网格参数
 *
 * 步距 = 线宽 + 间距；列数/行数由区域宽高按步距取整得到。
 * 横纵步距一致，所以格子永远是正方形，矩形区域靠行列数铺满，而不是把格子拉长。
 *
 * @param options - 界面参数
 * @returns 网格参数
 */
function calcGrid(options) {
	const lineWidth = Number(options.lineWidth);
	const gap = Number(options.gap);
	const width = Number(options.width);
	const height = Number(options.height);

	if (!(lineWidth > 0)) {
		throw new Error('线宽必须大于 0');
	}
	if (!(gap >= 0)) {
		throw new Error('间距不能小于 0');
	}
	if (!(width > 0) || !(height > 0)) {
		throw new Error('区域宽度和高度都必须大于 0');
	}

	const requestedPitchMm = lineWidth + gap;
	const widthMil = eda.sys_Unit.mmToMil(width);
	const heightMil = eda.sys_Unit.mmToMil(height);

	let pitch = eda.sys_Unit.mmToMil(requestedPitchMm);
	let cols = 0;
	let rows = 0;
	let adjusted = false;
	// 两端相邻要靠「走满一圈再剪开」，而格子总数为奇数时闭环不存在（棋盘染色）。
	// 这种尺寸上少一排一半、把步距补足，区域尺寸仍是填的那个，间距只大一点点。
	for (let guard = 0; guard < 8; guard += 1) {
		// +1e-6 吸收浮点误差，避免 20 / 0.4 = 49.999… 被 floor 成 49
		cols = Math.floor(widthMil / pitch + 1e-6) + 1;
		rows = Math.floor(heightMil / pitch + 1e-6) + 1;
		if (cols < 3 || rows < 3 || (cols * rows) % 2 === 0) {
			break;
		}
		const nextPitch = Math.min(widthMil / (cols - 2), heightMil / (rows - 2));
		// 步距只允许微调（5% 以内），否则宁可保持原样
		if (!(nextPitch > pitch) || nextPitch / pitch > 1.05) {
			break;
		}
		pitch = nextPitch;
		adjusted = true;
	}

	if (cols < 2 || rows < 2) {
		throw new Error('区域放不下一个步距（' + requestedPitchMm.toFixed(3) + ' mm），请减小线宽/间距或加大区域');
	}
	if (cols * rows > 40000) {
		throw new Error('网格过大（' + cols + ' × ' + rows + ' 格），请加大间距或缩小区域');
	}

	const pitchMm = eda.sys_Unit.milToMm(pitch);

	return {
		cols: cols,
		rows: rows,
		pitch: pitch,
		pitchMm: pitchMm,
		requestedPitchMm: requestedPitchMm,
		gapMm: pitchMm - lineWidth,
		adjusted: adjusted,
		realWidthMm: (cols - 1) * pitchMm,
		realHeightMm: (rows - 1) * pitchMm,
	};
}

/**
 * 铜箔电阻
 *
 * R = ρ(T) · L / (w · t)，其中 ρ(T) = ρ20 · (1 + α · (T - 20))。
 * 代入 Ω·mm²/m 与 mm / μm 后化简为 0.01724 · L[mm] / (w[mm] · t[μm])。
 *
 * @param lengthMm - 铜箔总长（mm）
 * @param lineWidthMm - 线宽（mm）
 * @param copperUm - 铜厚（μm）
 * @param tempC - 温度（℃）
 * @returns 电阻（Ω）
 */
function copperResistance(lengthMm, lineWidthMm, copperUm, tempC) {
	if (!(lengthMm > 0) || !(lineWidthMm > 0) || !(copperUm > 0)) {
		return NaN;
	}
	const rho = RHO_20 * (1 + ALPHA * ((Number(tempC) || 20) - 20));
	return (rho * lengthMm) / (lineWidthMm * copperUm);
}

/**
 * 合并共线点
 *
 * 希尔伯特曲线里有大量连续同向的格子（一段直线跨好几格），
 * 合成一条线段后图元数量能少一半以上，绘制速度提升明显，几何形状完全不变。
 *
 * @param points - 原始点序列
 * @returns 简化后的点序列
 */
function simplify(points) {
	if (points.length < 3) {
		return points;
	}
	const out = [points[0]];
	for (let i = 1; i < points.length - 1; i += 1) {
		const prev = out[out.length - 1];
		const cur = points[i];
		const next = points[i + 1];
		const d1x = cur[0] - prev[0];
		const d1y = cur[1] - prev[1];
		const d2x = next[0] - cur[0];
		const d2y = next[1] - cur[1];
		// 叉积不为 0 说明方向变了，必须保留该点
		if (Math.abs(d1x * d2y - d1y * d2x) > 1e-9) {
			out.push(cur);
		}
	}
	out.push(points[points.length - 1]);
	return out;
}

/**
 * 末端格子朝区域外的方向
 *
 * 只取水平或竖直，过孔才能用一段直角走线接过去；斜着拉会在孔盘旁边留下尖角，
 * 而且孔盘容易压到相邻走线。
 *
 * @param x - 末端 X（mil）
 * @param y - 末端 Y（mil）
 * @param cx - 区域中心 X（mil）
 * @param cy - 区域中心 Y（mil）
 * @returns 单位方向 `[dx, dy]`
 */
function outwardDirection(x, y, cx, cy) {
	const dx = x - cx;
	const dy = y - cy;
	if (Math.abs(dx) >= Math.abs(dy)) {
		return [dx >= 0 ? 1 : -1, 0];
	}
	return [0, dy >= 0 ? 1 : -1];
}

/**
 * 规划曲线（只算坐标，不碰 EDA 图元）
 *
 * 双面错开时：
 * - 顶层从底边的「端子位置」出发走到远端，在远端打一个过孔；
 * - 底层整体偏移半个步距（正好落在顶层的空隙里），从过孔绕回端子处；
 * - 两端各引出一段线当接线端子，避免两个端子只隔半个步距没法焊接。
 *
 * @param options - 界面参数
 * @returns 绘制计划 \`{ grid, targets, via, lengthMil }\`
 */
function planCurve(options) {
	const grid = calcGrid(options);
	// 单层：两端相邻（便于接线）；双面：两端拉开，过孔打在远端
	const closeEnds = options.layers !== 'both';
	const dual = options.layers === 'both';
	// 双面：起点落在底边的「端子位置」上，终点留给过孔
	const cells = HilbertCore.buildPath({
		cols: grid.cols,
		rows: grid.rows,
		mode: options.mode,
		close: closeEnds,
		dual: dual,
	});
	const layers = options.layers;
	const p = grid.pitch;
	const half = p / 2;
	const staggered = layers === 'both' && options.offset !== false;
	const useVia = staggered && options.via !== false;
	const leadMil = eda.sys_Unit.mmToMil(Math.max(0, Number(options.lead) || 0));
	const viaDiaMm = Math.max(0.2, Number(options.viaDiameter) || 0.6);
	const lineWidthMm = Number(options.lineWidth) > 0 ? Number(options.lineWidth) : 0.2;

	const cx = ((grid.cols - 1) * p) / 2;
	const cy = ((grid.rows - 1) * p) / 2;
	const last = cells[cells.length - 1];

	const top = [];
	const bottom = [];
	let via = null;

	if (staggered) {
		for (let i = 0; i < cells.length; i += 1) {
			top.push([cells[i][0] * p, cells[i][1] * p]);
		}
		// 底层整体偏移半个步距，末端正好落在顶层的空隙里
		const q = [last[0] * p + half, last[1] * p + half];
		const clearMil = eda.sys_Unit.mmToMil(0.2);
		if (useVia) {
			// 过孔沿边界法线挪到区域外面：孔盘边缘离最近走线还有 0.2 mm，
			// 两层都用直角接过去，不再斜着拉一段
			const outward = outwardDirection(last[0] * p, last[1] * p, cx, cy);
			const r = eda.sys_Unit.mmToMil(viaDiaMm / 2 + lineWidthMm / 2) + clearMil;
			via = { x: last[0] * p + outward[0] * r, y: last[1] * p + outward[1] * r };
			top.push([via.x, via.y]);
			bottom.push([via.x, via.y]);
			// 顶层末端与底层末端差半个步距，用一段直角折线过渡
			bottom.push(outward[0] !== 0 ? [via.x, q[1]] : [q[0], via.y]);
		}
		for (let i = cells.length - 1; i >= 0; i -= 1) {
			bottom.push([cells[i][0] * p + half, cells[i][1] * p + half]);
		}
		if (leadMil > 0) {
			const t0 = top[0];
			const q0 = bottom[bottom.length - 1];
			const onEdge = t0[0] === 0 || t0[0] === (grid.cols - 1) * p;
			const gapMil = eda.sys_Unit.mmToMil(0.8);
			if (onEdge) {
				// 端子在左右角上：顶层水平向外，底层竖直向外，两个端子自然拉开
				const dirX = t0[0] === 0 ? -1 : 1;
				top.unshift([t0[0] + dirX * leadMil, t0[1]]);
				const dirY = q0[1] - cy >= 0 ? 1 : -1;
				bottom.push([q0[0], q0[1] + dirY * leadMil]);
			} else {
				// 端子在底边中间：沿底边走会跟自己这层的走线短路，
				// 改成竖直向下、横让一步、再向下，全程直角，两个端子也拉开
				top.unshift([t0[0], t0[1] - leadMil]);
				const side = t0[0] <= ((grid.cols - 1) * p) / 2 ? 1 : -1;
				const dropMil = eda.sys_Unit.mmToMil(0.6);
				const jog = q0[0] + side * (leadMil + gapMil + eda.sys_Unit.mmToMil(1.2));
				const y = q0[1] - dropMil;
				bottom.push([q0[0], y]);
				bottom.push([jog, y]);
				bottom.push([jog, y - leadMil]);
			}
		}
	} else {
		for (let i = 0; i < cells.length; i += 1) {
			top.push([cells[i][0] * p, cells[i][1] * p]);
		}
	}

	const single = top;
	const targets = [];
	if (layers !== 'bottom') {
		targets.push({ layer: LAYER_TOP, points: single });
	}
	if (layers !== 'top') {
		targets.push({ layer: LAYER_BOTTOM, points: staggered ? bottom : single });
	}

	for (let t = 0; t < targets.length; t += 1) {
		targets[t].points = simplify(targets[t].points);
	}

	let lengthMil = 0;
	for (let t = 0; t < targets.length; t += 1) {
		const points = targets[t].points;
		for (let i = 1; i < points.length; i += 1) {
			const dx = points[i][0] - points[i - 1][0];
			const dy = points[i][1] - points[i - 1][1];
			lengthMil += Math.sqrt(dx * dx + dy * dy);
		}
	}

	return { grid: grid, targets: targets, via: via, lengthMil: lengthMil, staggered: staggered };
}

/**
 * 绘制希尔伯特曲线
 *
 * @param options - 界面传入的参数
 * @returns 绘制结果 \`{ drawn, total, interrupted, cols, rows, pitchMm, lengthMm, vias }\`
 */
async function drawHilbertCurve(options) {
	const lineWidthMm = Number(options.lineWidth);
	if (!(lineWidthMm > 0)) {
		throw new Error('线宽必须大于 0');
	}

	const plan = planCurve(options);
	if (plan.via && !eda.pcb_PrimitiveVia) {
		throw new Error('当前 EDA 版本不支持过孔 API，请取消「过孔串联」');
	}

	// 获取数据原点与画布原点的偏移量
	const canvas = await eda.pcb_Document.getCanvasOrigin();
	const originX = canvas['offsetX'] + eda.sys_Unit.mmToMil(Number(options.startX) || 0);
	const originY = canvas['offsetY'] + eda.sys_Unit.mmToMil(Number(options.startY) || 0);

	// 临时解决方案，2.2.35.4 已修复
	const lineWidth = eda.sys_Unit.mmToMil(lineWidthMm);

	// 先把所有线段拍平，再分批并发提交，比逐段 await 快一个数量级
	const segments = [];
	for (let t = 0; t < plan.targets.length; t += 1) {
		const target = plan.targets[t];
		for (let i = 1; i < target.points.length; i += 1) {
			segments.push([
				target.layer,
				originX + target.points[i - 1][0],
				originY + target.points[i - 1][1],
				originX + target.points[i][0],
				originY + target.points[i][1],
			]);
		}
	}

	const total = segments.length;
	const CHUNK = 24;
	let drawn = 0;
	let vias = 0;
	try {
		for (let i = 0; i < segments.length; i += CHUNK) {
			if (stopped) {
				break;
			}
			const batch = [];
			const end = Math.min(i + CHUNK, segments.length);
			for (let k = i; k < end; k += 1) {
				const s = segments[k];
				batch.push(eda.pcb_PrimitiveLine.create(NET_NAME, s[0], s[1], s[2], s[3], s[4], lineWidth));
			}
			await Promise.all(batch);
			drawn += batch.length;
		}
		if (!stopped && plan.via) {
			await eda.pcb_PrimitiveVia.create(
				NET_NAME,
				originX + plan.via.x,
				originY + plan.via.y,
				eda.sys_Unit.mmToMil(Math.max(0.05, Number(options.viaHole) || 0.3)),
				eda.sys_Unit.mmToMil(Math.max(0.1, Number(options.viaDiameter) || 0.6)),
			);
			vias = 1;
		}
	} finally {
		// 无论成功、失败还是中断都要复位，否则下一次绘制会立即空转返回
		stopped = false;
	}

	return {
		drawn: drawn,
		total: total,
		interrupted: drawn < total,
		cols: plan.grid.cols,
		rows: plan.grid.rows,
		pitchMm: plan.grid.pitchMm,
		lengthMm: eda.sys_Unit.milToMm(plan.lengthMil),
		vias: vias,
	};
}

/**
 * 用 PCB 上实际网络的线长计算电阻
 *
 * @param options - 界面参数
 * @returns \`{ lengthMm, r20, rTemp, tempC }\`
 */
async function calcResistance(options) {
	const lengthMil = await eda.pcb_Net.getNetLength(NET_NAME);
	const lengthMm = eda.sys_Unit.milToMm(lengthMil);
	const lineWidthMm = Number(options.lineWidth);
	// 界面按 oz 输入，1 oz = 35 μm
	const copperUm = (Number(options.copper) || 1) * 35;
	const tempC = Number(options.temp) || 20;

	return {
		lengthMm: lengthMm,
		r20: copperResistance(lengthMm, lineWidthMm, copperUm, 20),
		rTemp: copperResistance(lengthMm, lineWidthMm, copperUm, tempC),
		tempC: tempC,
	};
}