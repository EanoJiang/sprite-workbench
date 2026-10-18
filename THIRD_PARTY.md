# 上游模型与代码

本工具通过本地 Python 适配器调用以下官方项目，第三方模型与代码不属于 Framecraft 自有代码。

GitHub 仓库保留本工具的集成代码、复现补丁、来源说明和许可原文，不分发第三方模型权重或运行时二进制。XSXB 补丁包包含固定版本的六个相关源文件及其修改版，用于离线重放和测试；完整上游项目由 `setup.ps1` 按固定版本获取至 `backend/vendor/`。模型与运行时组件由对应的准备流程获取，安装目录不随仓库提交。

## BiRefNet

- 项目：https://github.com/ZhengPeng7/BiRefNet
- 作者：Peng Zheng 等。
- 代码许可：MIT；模型以官方 Hugging Face 仓库对应许可为准。
- 模型：`ZhengPeng7/BiRefNet`、`ZhengPeng7/BiRefNet_HR-matting`、`ZhengPeng7/BiRefNet_lite`。
- 精确模型与 Python 远程代码 revision 固定在 `backend/birefnet_runner.py`，不执行任意用户提供的模型代码。

## CorridorKey — Corridor Digital

- 官方项目：https://github.com/nikopueringer/CorridorKey
- 固定源码：`97e55a453060745bead1befd293f6e523c4b845c`。
- `setup.ps1` 获取固定版本源码至本地 `backend/vendor/CorridorKey`，包含官方 README 和 LICENSE。
- 遵循上游自定义许可（基于 CC BY-NC-SA 4.0）。官方允许处理商业项目素材，但重新包装销售、收费推理服务或商业软件集成等用途受额外限制，需按上游条款另行安排。
- 此处用于用户设备上的本地素材处理，不提供收费外部推理服务。

如分发本工具及第三方源码、权重或其改动，请同时保留各上游完整许可、署名及相应义务。以下载版本随附的完整 LICENSE 为准。

## XSXB Frame Tuner

- 官方项目：https://github.com/sparklecatta-lang/XSXB-Frame-Tuner
- 作者：sparklecatta-lang 及上游贡献者。
- 固定源码：`cb061e15132b9250feebd34a18a3fd023197837c`。
- 许可：MIT；完整许可随集成补丁归档在 [`docs/licenses/LICENSE.XSXB-Frame-Tuner`](docs/licenses/LICENSE.XSXB-Frame-Tuner)，本地安装目录仍保留上游 LICENSE。
- 集成方式：按需启动官方 Lite 服务，在独立标签页嵌入编辑器，通过官方 PNG 序列导入脚本导入素材。
- 本地兼容改动：共享预设的迁移记录不再导致其他项目的保存版本失效；Lite 的首次载入及重置视图自动适配当前帧。实际调参内容与共享预设变更仍受保存版本检查保护。
- 兼容补丁由 `backend/patches/apply_xsxb_compat.py` 校验固定版本源码后应用。额外的画布偏移与缩放、锚点导入、保存回传等集成改动也保存在 `backend/patches/`，供安装时复现；保留上游署名及完整 MIT 许可。

## Real-ESRGAN / NCNN Vulkan

- 官方项目：[Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN)；便携推理实现：[Real-ESRGAN-ncnn-vulkan](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan)。作者与贡献者包括 Xintao Wang、nihui 及上游贡献者。
- 实际使用 [Real-ESRGAN v0.2.5.0 官方发布](https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0)中的 Windows 便携组件 `realesrgan-ncnn-vulkan-20220424-windows.zip`。
- 安装包 SHA-256：`abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d`；来源与校验值记录于 `backend/runtime/realesrgan/framecraft-runtime.json`。
- 平滑功能调用 `realesrgan-x4plus-anime` 模型，实际文件为 `backend/runtime/realesrgan/models/realesrgan-x4plus-anime.param` 和 `backend/runtime/realesrgan/models/realesrgan-x4plus-anime.bin`；先通过官方 NCNN Vulkan 程序放大 4 倍，再以 Lanczos 还原原尺寸并保留原始透明度。
- Real-ESRGAN 的完整许可为 [BSD 3-Clause](https://github.com/xinntao/Real-ESRGAN/blob/v0.2.5.0/LICENSE)；NCNN Vulkan 适配项目的完整 [MIT 许可](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/master/LICENSE)同时包含 `realsr-ncnn-vulkan` 的 MIT 署名。
- 官方便携安装包没有随附 LICENSE、COPYING 或 NOTICE 文件，已从上述官方仓库另外归档完整原文并随 GitHub 仓库提交：Real-ESRGAN 位于 [`docs/licenses/LICENSE.Real-ESRGAN`](docs/licenses/LICENSE.Real-ESRGAN)；NCNN Vulkan 适配项目及其 `realsr-ncnn-vulkan` 署名位于 [`docs/licenses/LICENSE.Real-ESRGAN-ncnn-vulkan`](docs/licenses/LICENSE.Real-ESRGAN-ncnn-vulkan)。本机运行时目录中的原件继续保留；官方组件说明在安装后位于 `backend/runtime/realesrgan/README_windows.md`。
