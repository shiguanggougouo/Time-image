# Time image — Time AI

Standalone ComfyUI nodes for image/mask resolution fitting, pose extraction, and depth extraction. The pose backend is bundled locally and does not invoke another node package.

## Nodes
- **Time・Res Fixer (Img/Mask)** — fit an image and optional mask to a divisible canvas.
- **Time Pose Extractor** — OpenPose or DWPose, with body, hand, and face switches.
- **Time Depth Model Loader** and **Time Depth Extractor** — load Depth Anything V2 and generate depth maps.

## Installation
Copy the `Time-image` folder into `ComfyUI/custom_nodes/` and restart ComfyUI.

## Manual model files
All models are stored under `ComfyUI/models/Time-image/`, split into `pose/` and `depth/`.

### Pose models
- From [lllyasviel/Annotators](https://huggingface.co/lllyasviel/Annotators), download OpenPose files `body_pose_model.pth`, `hand_pose_model.pth`, and `facenet.pth`. Place them in `ComfyUI/models/Time-image/pose/lllyasviel/Annotators/`.
- From [yzd-v/DWPose](https://huggingface.co/yzd-v/DWPose), download `yolox_l.onnx` and `dw-ll_ucoco_384.onnx`. Place them in `ComfyUI/models/Time-image/pose/yzd-v/DWPose/`.

### Depth models
From [Kijai/DepthAnythingV2-safetensors](https://huggingface.co/Kijai/DepthAnythingV2-safetensors), download one supported file: `depth_anything_v2_vits_fp16.safetensors`, `depth_anything_v2_vitb_fp16.safetensors`, or `depth_anything_v2_vitl_fp16.safetensors`. Place it in `ComfyUI/models/Time-image/depth/`.

The nodes attempt to download missing model files on first use. DWPose requires ONNX Runtime. OpenPose code retains its upstream non-commercial license; review the license before commercial use.

# Time image — Time AI（中文说明）

Time image 是一组独立的 ComfyUI 节点，提供图像/遮罩尺寸修正、骨骼图提取和深度图提取。骨骼检测代码随本包提供，不调用其它节点包。

## 节点
- **Time・Res Fixer (Img/Mask)**：将图像和可选遮罩调整到指定倍数的画布尺寸。
- **Time Pose Extractor**：选择 OpenPose 或 DWPose，并可分别启用或关闭身体、手部和脸部检测。
- **Time Depth Model Loader** 与 **Time Depth Extractor**：加载 Depth Anything V2 并生成深度图。

## 安装
将 `Time-image` 文件夹复制到 `ComfyUI/custom_nodes/`，然后重启 ComfyUI。

## 手动下载模型
所有模型统一放在 `ComfyUI/models/Time-image/`，并分为 `pose/` 和 `depth/` 两个子目录。

### 骨骼模型
- 从 [lllyasviel/Annotators](https://huggingface.co/lllyasviel/Annotators) 下载 OpenPose 文件：`body_pose_model.pth`、`hand_pose_model.pth` 和 `facenet.pth`。放入 `ComfyUI/models/Time-image/pose/lllyasviel/Annotators/`。
- 从 [yzd-v/DWPose](https://huggingface.co/yzd-v/DWPose) 下载 `yolox_l.onnx` 和 `dw-ll_ucoco_384.onnx`。放入 `ComfyUI/models/Time-image/pose/yzd-v/DWPose/`。

### 深度模型
从 [Kijai/DepthAnythingV2-safetensors](https://huggingface.co/Kijai/DepthAnythingV2-safetensors) 下载以下任意一个文件：`depth_anything_v2_vits_fp16.safetensors`、`depth_anything_v2_vitb_fp16.safetensors` 或 `depth_anything_v2_vitl_fp16.safetensors`。放入 `ComfyUI/models/Time-image/depth/`。

缺少模型时节点会尝试在首次使用时自动下载。DWPose 需要 ONNX Runtime。OpenPose 上游代码带有非商业许可，商用前请查看许可条款。
