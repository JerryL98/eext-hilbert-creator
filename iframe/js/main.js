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
 * 末端格子最近的一条边，朝外的方向
 *
 * 只取水平或竖直，过孔才能用一段直角走线接过去；取最近的那条边，
 * 引出的那一段立刻离开区域，不会顺着边沿跟别的走线并排。
 *
 * @param x - 末端 X（mil）
 * @param y - 末端 Y（mil）
 * @param maxX - 区域右边 X（mil）
 * @param maxY - 区域上边 Y（mil）
 * @returns 单位方向 `[dx, dy]`
 */
function edgeDirection(x, y, maxX, maxY) {
	const left = x;
	const right = maxX - x;
	const bottom = y;
	const top = maxY - y;
	const min = Math.min(left, right, bottom, top);
	if (min === left) {
		return [-1, 0];
	}
	if (min === right) {
		return [1, 0];
	}
	return min === bottom ? [0, -1] : [0, 1];
}

/** 点到线段的距离 */
function distToSegment(px, py, a, b) {
	const vx = b[0] - a[0];
	const vy = b[1] - a[1];
	const wx = px - a[0];
	const wy = py - a[1];
	const len2 = vx * vx + vy * vy;
	let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	const dx = px - (a[0] + t * vx);
	const dy = py - (a[1] + t * vy);
	return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 过孔落点：沿外法线往外挪，直到孔盘对两层所有走线都留出间距
 *
 * 只按「孔半径 + 半线宽」从末端格子甩出去并不够：底层错开了半个步距，
 * 它的端点和附近几条线都可能落进孔盘。这里对所有线段实测距离，
 * 取最靠里的合法位置，孔盘既不压线又不会无谓地跑太远。
 *
 * @param base - 末端格子坐标 `[x, y]`
 * @param dir - 外法线
 * @param minDist - 起算距离（底层错开半个步距时，要留出一个步距才不会贴着相邻走线）
 * @param need - 孔心到走线中心线的最小距离（孔半径 + 半线宽 + 间距）
 * @param polylines - 两层所有格点连线
 * @returns `{ x, y }` 过孔坐标
 */
function placeVia(base, dir, minDist, need, polylines) {
	const step = eda.sys_Unit.mmToMil(0.05);
	const reach = minDist + eda.sys_Unit.mmToMil(12);
	const farX = base[0] + dir[0] * reach;
	const farY = base[1] + dir[1] * reach;
	const minX = Math.min(base[0], farX) - need;
	const maxX = Math.max(base[0], farX) + need;
	const minY = Math.min(base[1], farY) - need;
	const maxY = Math.max(base[1], farY) + need;
	// 只留下法线方向上那条带子里的线段，几万段通常只剩几十段
	const local = [];
	for (let p = 0; p < polylines.length; p += 1) {
		const poly = polylines[p];
		for (let i = 1; i < poly.length; i += 1) {
			const a = poly[i - 1];
			const b = poly[i];
			if (Math.max(a[0], b[0]) < minX || Math.min(a[0], b[0]) > maxX) {
				continue;
			}
			if (Math.max(a[1], b[1]) < minY || Math.min(a[1], b[1]) > maxY) {
				continue;
			}
			local.push(a, b);
		}
	}
	let dist = Math.max(minDist, need);
	let point = { x: base[0] + dir[0] * dist, y: base[1] + dir[1] * dist };
	// 挪过的距离单调增大，最多试探几次就会停
	for (let guard = 0; guard < 400 && local.length > 0; guard += 1) {
		let worst = Infinity;
		for (let i = 0; i < local.length; i += 2) {
			const d = distToSegment(point.x, point.y, local[i], local[i + 1]);
			if (d < worst) {
				worst = d;
			}
		}
		if (worst >= need - 1e-6) {
			break;
		}
		// 差多少挪多少，至少挪一小步，避免贴着走线反复试探
		dist += Math.max(need - worst, step);
		point = { x: base[0] + dir[0] * dist, y: base[1] + dir[1] * dist };
	}
	return point;
}

/**
 * 单层模式的引出线
 *
 * 单层的两个端子本来就只隔一个步距，一起朝外引还是挤在一起，焊盘会连成一片。
 * 所以一端直接引出，另一端先离开区域、横让一步再引出，两个焊位才算真正分开。
 * 所有引出段都走直角。
 *
 * @param points - 路径点序列，原地前插/后接
 * @param leadMil - 引出线长度（mil）
 * @param pitch - 步距（mil）
 */
function leadSingle(points, leadMil, pitch) {
	const first = points[0];
	const lastPoint = points[points.length - 1];
	const gapMil = eda.sys_Unit.mmToMil(0.8);
	// 横让那一段要跟底边那排走线保持一个步距，线宽大时不能还是 0.6 mm
	const dropMil = Math.max(eda.sys_Unit.mmToMil(0.6), pitch);
	// 横让的距离既要不小于引出线本身，又要够两个焊位摆开烙铁
	const sideMil = Math.max(leadMil + gapMil + eda.sys_Unit.mmToMil(1.2), 2.5 * pitch);
	const attach = function (atStart, pts) {
		for (let i = 0; i < pts.length; i += 1) {
			if (atStart) {
				points.unshift(pts[i]);
			} else {
				points.push(pts[i]);
			}
		}
	};
	if (Math.abs(first[1] - lastPoint[1]) < 1e-6 && Math.abs(first[0] - lastPoint[0]) <= 2.5 * pitch) {
		// 两端相邻（走满一圈再剪开）：右端直着引出，左端先往下让、横挪一步、再引出
		const rightIsFirst = first[0] >= lastPoint[0];
		const big = rightIsFirst ? first : lastPoint;
		const small = rightIsFirst ? lastPoint : first;
		attach(rightIsFirst, [[big[0], big[1] - leadMil]]);
		attach(!rightIsFirst, [
			[small[0], small[1] - dropMil],
			[small[0] - sideMil, small[1] - dropMil],
			[small[0] - sideMil, small[1] - dropMil - leadMil],
		]);
		return;
	}
	// 两端本来就分得开：各自沿最近的边直着引出
	let maxX = first[0];
	let maxY = first[1];
	for (let i = 1; i < points.length; i += 1) {
		maxX = Math.max(maxX, points[i][0]);
		maxY = Math.max(maxY, points[i][1]);
	}
	const headDir = edgeDirection(first[0], first[1], maxX, maxY);
	const tailDir = edgeDirection(lastPoint[0], lastPoint[1], maxX, maxY);
	attach(false, [[lastPoint[0] + tailDir[0] * leadMil, lastPoint[1] + tailDir[1] * leadMil]]);
	attach(true, [[first[0] + headDir[0] * leadMil, first[1] + headDir[1] * leadMil]]);
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

	const cy = ((grid.rows - 1) * p) / 2;
	const last = cells[cells.length - 1];

	const top = [];
	const bottom = [];
	let via = null;

	if (staggered) {
		const topCells = [];
		const bottomCells = [];
		for (let i = 0; i < cells.length; i += 1) {
			topCells.push([cells[i][0] * p, cells[i][1] * p]);
			// 底层整体偏移半个步距，末端正好落在顶层的空隙里
			bottomCells.push([cells[i][0] * p + half, cells[i][1] * p + half]);
		}
		for (let i = 0; i < topCells.length; i += 1) {
			top.push(topCells[i]);
		}
		if (useVia) {
			// 过孔沿最近的边挪到区域外面，一直挪到孔盘对两层所有走线都留出间距；
			// 两层都用直角接过去，不再斜着拉一段
			const clearMil = eda.sys_Unit.mmToMil(0.2);
			const outward = edgeDirection(last[0] * p, last[1] * p, (grid.cols - 1) * p, (grid.rows - 1) * p);
			const need = eda.sys_Unit.mmToMil(viaDiaMm / 2 + lineWidthMm / 2) + clearMil;
			// 底层末端错开半个步距，接过去的那段会跟底层的走线平行：
			// 至少让出「半格 + 一个步距」，两者的间距才跟图案里一致
			const minDist = Math.max(need, half + p);
			via = placeVia(topCells[topCells.length - 1], outward, minDist, need, [topCells, bottomCells]);
			top.push([via.x, via.y]);
			bottom.push([via.x, via.y]);
			// 顶层末端与底层末端差半个步距，用一段直角折线过渡
			const q = bottomCells[bottomCells.length - 1];
			bottom.push(outward[0] !== 0 ? [via.x, q[1]] : [q[0], via.y]);
		}
		for (let i = bottomCells.length - 1; i >= 0; i -= 1) {
			bottom.push(bottomCells[i]);
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
				// 横让朝过孔的相反方向：过孔也在这一侧时，让出去的那段会扫到孔盘
				const side = via ? (q0[0] >= via.x ? 1 : -1) : t0[0] <= ((grid.cols - 1) * p) / 2 ? 1 : -1;
				// 横让那一步要离开底边一个步距，线宽大时不能还是 0.6 mm
				const dropMil = Math.max(eda.sys_Unit.mmToMil(0.6), p);
				const jog = q0[0] + side * (leadMil + gapMil + eda.sys_Unit.mmToMil(1.2));
				top.unshift([t0[0], t0[1] - leadMil]);
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
		// 单层没有过孔，两个端子只隔一个步距，同样需要引出线分开
		if (leadMil > 0) {
			leadSingle(top, leadMil, p);
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