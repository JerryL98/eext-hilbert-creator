# eext-hilbert-creator

嘉立创EDA & EasyEDA 专业版扩展 —— 希尔伯特曲线生成器

<a href="https://github.com/klxf/eext-hilbert-creator" style="vertical-align: inherit;" target="_blank"><img src="https://img.shields.io/github/stars/klxf/eext-hilbert-creator" alt="GitHub Repo Stars" class="not-medium-zoom-image" style="display: inline; vertical-align: inherit;" /></a>&nbsp;<a href="https://github.com/klxf/eext-hilbert-creator/issues" style="vertical-align: inherit;" target="_blank"><img src="https://img.shields.io/github/issues/klxf/eext-hilbert-creator" alt="GitHub Issues" class="not-medium-zoom-image" style="display: inline; vertical-align: inherit;" /></a>&nbsp;<a href="https://github.com/klxf/eext-hilbert-creator" style="vertical-align: inherit;" target="_blank"><img src="https://img.shields.io/github/repo-size/klxf/eext-hilbert-creator" alt="GitHub Repo Size" class="not-medium-zoom-image" style="display: inline; vertical-align: inherit;" /></a>&nbsp;<a href="https://choosealicense.com/licenses/unlicense/" style="vertical-align: inherit;" target="_blank"><img src="https://img.shields.io/github/license/klxf/eext-hilbert-creator" alt="GitHub License" class="not-medium-zoom-image" style="display: inline; vertical-align: inherit;" /></a>&nbsp;<img src="https://img.shields.io/badge/EasyEDA-%5E2.2.35-5588ff" alt="NPM Version" class="not-medium-zoom-image" style="display: inline; vertical-align: inherit;" />

> [!NOTE]
>
> 本拓展目前仍在开发阶段

## 开始使用

这是一个 **嘉立创EDA** 或 **EasyEDA** 专业版的拓展，可以便捷地在 PCB 中绘制希尔伯特曲线并计算电阻值。

1. 下载本拓展，在 **嘉立创EDA** 或 **EasyEDA** 专业版中安装

2. 在PCB页面中，点击顶部菜单的 `希尔伯特`，即可打开本拓展

3. 使用很简单 —— 输入线宽、间距、起始点、区域宽高，即可自动生成希尔伯特曲线，并实时显示步距、网格、线长与电阻

    - **步距** = 线宽 + 间距，横纵一致，所以格子永远是正方形；区域宽高决定列数与行数，矩形靠行列铺满，不会把曲线拉长
    - **双面错开**：底层整体偏移半个步距，正好落在顶层走线的空隙里，正反面交替发热，温度更均匀
    - **过孔串联**：在远端打一个过孔把正反面接成一条回路，近端两层的末端各引出一段线当接线端子
    - **电阻**：按铜厚与温度计算，R = ρ(T) · L / (w · t)，ρ₂₀ = 0.01724 Ω·mm²/m，α = 0.00393 /℃
    - **布线层**：可选顶层、底层或双面（顶+底）
      ![img-1](https://github.com/user-attachments/assets/81089c2d-2743-4268-843e-5e413906ea87)

4. 使用“铜线阻值计算器”功能，可以便捷计算线长或线宽
   ![img-2](https://github.com/user-attachments/assets/0ccc5e3e-77e8-4d29-988e-2ab891d1763c)

## 文言脚本

适用于 [吾有一术](https://github.com/klxf/eext-wenyan) 拓展的文言脚本：[绘希氏图](https://github.com/klxf/eext-hilbert-creator/blob/master/src/%E7%B9%AA%E5%B8%8C%E6%B0%8F%E5%9C%96.wy)

## 开源许可

<a href="https://choosealicense.com/licenses/unlicense/" style="vertical-align: inherit;" target="_blank"><img src="https://img.shields.io/github/license/klxf/eext-hilbert-creator" alt="GitHub License" class="not-medium-zoom-image" style="display: inline; vertical-align: inherit;" /></a>

本项目使用 [The Unlicense](https://choosealicense.com/licenses/unlicense/) 开源许可协议