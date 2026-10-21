let stopped = false;

function stopDrawing() {
	stopped = true;
}

/**
 * 计算网格参数
 *
 * 列数由迭代次数决定（2^n），步距 = 区域宽 / (列数 - 1)，行数按步距铺满区域高。
 * 横纵步距一致，因此所有格子都是正方形，矩形靠行数填满而不是拉伸。
 *
 * @param options - 界面参数
 * @returns 网格参数
 */
function calcGrid(options) {
	const iterations = Math.round(Number(options.iterations));
	const width = Number(options.width);
	const height = Number(options.height);

	if (!(iterations >= 1)) {
		throw new Error('迭代次数必须大于等于 1');
	}
	if (!(width > 0) || !(height > 0)) {
		throw new Error('区域宽度和高度都必须大于 0');
	}

	const cols = Math.pow(2, iterations);
	if (cols > 2048) {
		throw new Error('迭代次数过大（列数 ' + cols + '），请减小迭代次数');
	}

	const widthMil = eda.sys_Unit.mmToMil(width);
	const heightMil = eda.sys_Unit.mmToMil(height);
	const pitch = widthMil / (cols - 1);
	const rows = Math.max(1, Math.round(heightMil / pitch) + 1);

	if (cols * rows > 20000) {
		throw new Error('网格过大（' + cols + ' × ' + rows + ' 格 ≈ ' + cols * rows + ' 段），请减小迭代次数或区域尺寸');
	}

	return { iterations: iterations, cols: cols, rows: rows, pitch: pitch, widthMil: widthMil, heightMil: heightMil };
}

/**
 * 绘制希尔伯特曲线
 *
 * @param options - 界面传入的参数
 * @returns 绘制结果 \\\`{ drawn, total, interrupted, cols, rows, pitch }\\\`
 */
async function drawHilbertCurve(options) {
	const lineWidthInput = Number(options.lineWidth);
	const startX = Number(options.startX) || 0;
	const startY = Number(options.startY) || 0;

	if (!(lineWidthInput > 0)) {
		throw new Error('线宽必须大于 0');
	}

	const grid = calcGrid(options);

	// 获取数据原点与画布原点的偏移量
	const offset = await eda.pcb_Document.getCanvasOrigin();
	const originX = offset['offsetX'] + eda.sys_Unit.mmToMil(startX);
	const originY = offset['offsetY'] + eda.sys_Unit.mmToMil(startY);

	// 临时解决方案，2.2.35.4 已修复
	const lineWidth = eda.sys_Unit.mmToMil(lineWidthInput);

	const cells = HilbertCore.buildPath({ cols: grid.cols, rows: grid.rows, mode: options.mode });

	const box = {
		x0: originX,
		y0: originY,
		width: (grid.cols - 1) * grid.pitch,
		height: (grid.rows - 1) * grid.pitch,
	};
	const mirror = options.mirror || 'none';
	const targets = [];
	if (options.layers === 'bottom') {
		targets.push({ layer: HilbertCore.LAYER_BOTTOM, mirror: mirror });
	} else if (options.layers === 'both') {
		targets.push({ layer: HilbertCore.LAYER_TOP, mirror: 'none' });
		targets.push({ layer: HilbertCore.LAYER_BOTTOM, mirror: mirror });
	} else {
		targets.push({ layer: HilbertCore.LAYER_TOP, mirror: 'none' });
	}

	const total = cells.length - 1;
	let drawn = 0;
	try {
		for (let i = 1; i < cells.length; i += 1) {
			if (stopped) {
				break;
			}
			const fromX = originX + cells[i - 1][0] * grid.pitch;
			const fromY = originY + cells[i - 1][1] * grid.pitch;
			const toX = originX + cells[i][0] * grid.pitch;
			const toY = originY + cells[i][1] * grid.pitch;
			for (const target of targets) {
				const a = HilbertCore.transform(fromX, fromY, target.mirror, box);
				const b = HilbertCore.transform(toX, toY, target.mirror, box);
				await eda.pcb_PrimitiveLine.create(HilbertCore.NET_NAME, target.layer, a[0], a[1], b[0], b[1], lineWidth);
			}
			drawn += 1;
		}
	} finally {
		// 无论成功、失败还是中断都要复位，否则下一次绘制会立即空转返回
		stopped = false;
	}

	return {
		drawn: drawn,
		total: total,
		interrupted: drawn < total,
		cols: grid.cols,
		rows: grid.rows,
		pitch: grid.pitch,
	};
}

async function calcResistance(lineWidth) {
	// R=(ρL)/(1000WD)
	const r = 0.0175;
	const W = lineWidth;
	const D = 0.035;

	try {
		const length = await eda.pcb_Net.getNetLength('HILBERT');
		return (r * eda.sys_Unit.milToMm(length)) / (1000 * W * D);
	} catch (error) {
		console.error('Error calculating resistance: ', error);
		throw error;
	}
}
