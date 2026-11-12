# Third-party notices / 第三方声明

Time image bundles third-party code. The root [`LICENSE`](LICENSE) explains how
the project's own MIT-licensed code and these upstream licenses fit together;
this file is the quick reference.
本仓库包含第三方代码。根目录 [`LICENSE`](LICENSE) 说明了原创代码与第三方许可的关系，
本文件是速查清单。

| Directory / 目录 | Upstream / 上游 | License / 许可 | Key restriction / 关键限制 |
| --- | --- | --- | --- |
| `custom_controlnet_aux/open_pose/` | [CMU OpenPose](https://github.com/CMU-Perceptual-Computing-Lab/openpose) | CMU OpenPose Software License Agreement — **Academic or non-profit organization noncommercial research use only** (`open_pose/LICENSE`) | 仅限非商业研究；不得转授权；对再分发有限制 |
| `custom_controlnet_aux/dwpose/` | [DWPose / MMPose](https://github.com/IDEA-Research/DWPose) | 目录内附带的 `dwpose/LICENSE` 与上面是**同一份 CMU 非商业研究许可**；源码头部亦写明 "licensed by CMU for non-commercial use only" | 同上 |
| `depth_anything_v2/` | [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2) / [DINOv2](https://github.com/facebookresearch/dinov2) | Apache License 2.0 (`depth_anything_v2/LICENSE`) | 需保留版权声明与许可文本 |

## What this means / 结论

- **Original code** (root `__init__.py` and this project's docs): MIT License —
  free to use, modify and redistribute on its own.
  **作者原创代码**（根目录 `__init__.py` 与本文档）：MIT 许可，单独使用时可自由使用、修改、分发。
- **The bundled package as a whole**: because the CMU license allows only
  noncommercial research use and grants no sublicensing rights, the complete
  package may **only be used for noncommercial research**. Commercial use
  requires removing/replacing the CMU-licensed components or obtaining written
  permission from Carnegie Mellon University.
  **整个分发包**：由于 CMU 许可只允许非商业研究、且不允许转授权，完整包**仅可用于非商业研究**。
  商用需先移除或替换 CMU 组件，或取得 Carnegie Mellon University 的书面许可。
- The MIT grant on the original code does **not** override or sublicense any
  third-party license. MIT 授权不覆盖、也不改变任何第三方条款。
- **Model weights are not shipped** with this project. Users download them
  separately (see README.md); each has its own upstream license.
  **模型权重不随本仓库分发**，由用户按 README 自行下载，各自适用上游许可。
- The CMU license also restricts redistribution. Publishing this package to a
  public registry, mirroring it, or shipping it with a commercial product
  should be reviewed against the upstream terms. CMU 许可对再分发亦有限制，
  公开上架、镜像或随商业产品分发前请自行核对上游条款。

If commercial use matters, the cleanest route is to replace the OpenPose /
DWPose backends with an implementation under a commercial-friendly license, or
make them optional external dependencies so the published package contains only
original + Apache-2.0 code.
如果以后需要商用，最干净的做法是：把 OpenPose / DWPose 后端换成商用友好的实现，
或改成可选外部依赖，让发布包里只保留原创代码与 Apache-2.0 代码。
