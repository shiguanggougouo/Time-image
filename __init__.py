import math

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
import os
from contextlib import nullcontext

import comfy.model_management as mm
from comfy.utils import ProgressBar, load_torch_file
import folder_paths
from .depth_anything_v2.dpt import DepthAnythingV2
import sys

# Keep the detector implementation local to this custom-node package.
_PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
if _PACKAGE_DIR not in sys.path:
    sys.path.insert(0, _PACKAGE_DIR)


_RESAMPLING = {
    "lanczos": Image.Resampling.LANCZOS,
    "bicubic": Image.Resampling.BICUBIC,
    "hamming": Image.Resampling.HAMMING,
    "bilinear": Image.Resampling.BILINEAR,
    "box": Image.Resampling.BOX,
    "nearest": Image.Resampling.NEAREST,
}
_MULTIPLES = [2, 4, 8, 14, 16, 28, 32, 64, 128, 256, 512]


def _reflection_indices(length, before, after, device):
    """Indices matching OpenCV BORDER_REFLECT_101 (edge pixel is not repeated)."""
    coords = torch.arange(-before, length + after, device=device)
    if length <= 1:
        return torch.zeros_like(coords)
    period = 2 * (length - 1)
    folded = torch.remainder(coords, period)
    return torch.where(folded < length, folded, period - folded).long()


def _resize_geometry(width, height, target_width, target_height, fit):
    if fit in ("smart_fill", "letterbox"):
        scale = min(target_width / width, target_height / height)
        return max(1, int(width * scale)), max(1, int(height * scale))
    if fit == "crop":
        scale = max(target_width / width, target_height / height)
        return max(target_width, int(width * scale)), max(target_height, int(height * scale))
    return target_width, target_height


def _fit_mask(mask, target_width, target_height, fit, resized_width, resized_height):
    # mask shape: [B,H,W]. Nearest-neighbor keeps mask values and boundaries intact.
    mask = F.interpolate(mask.unsqueeze(1).float(), size=(resized_height, resized_width), mode="nearest").squeeze(1)
    if fit == "crop":
        left = (resized_width - target_width) // 2
        top = (resized_height - target_height) // 2
        return mask[:, top:top + target_height, left:left + target_width]

    if fit in ("smart_fill", "letterbox"):
        pad_w = target_width - resized_width
        pad_h = target_height - resized_height
        left, top = pad_w // 2, pad_h // 2
        right, bottom = pad_w - left, pad_h - top
        if fit == "letterbox":
            return F.pad(mask, (left, right, top, bottom), mode="constant", value=0)
        yi = _reflection_indices(resized_height, top, bottom, mask.device)
        xi = _reflection_indices(resized_width, left, right, mask.device)
        return mask.index_select(1, yi).index_select(2, xi)

    return mask


class ImageMaskResolutionFixer:
    """Time AI node: resize image and mask together to divisible dimensions."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "fit": (["smart_fill", "letterbox", "crop", "fill"], {"default": "smart_fill"}),
                "method": (["lanczos", "bicubic", "hamming", "bilinear", "box", "nearest"], {"default": "lanczos"}),
                "round_to_multiple": (_MULTIPLES, {"default": 32}),
            },
            "optional": {
                "mask": ("MASK",),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "width", "height")
    FUNCTION = "resize_image_mask"
    CATEGORY = "Time AI/图像"

    def resize_image_mask(self, image, fit, method, round_to_multiple, mask=None):
        if image.ndim != 4 or image.shape[-1] not in (1, 3, 4):
            raise ValueError(f"Expected IMAGE [B,H,W,C] with 1, 3, or 4 channels; got {tuple(image.shape)}")
        if mask is not None and mask.ndim != 3:
            raise ValueError(f"Expected MASK [B,H,W]; got {tuple(mask.shape)}")
        if fit not in ("smart_fill", "letterbox", "crop", "fill"):
            raise ValueError(f"Unknown fit mode: {fit}")
        if method not in _RESAMPLING:
            raise ValueError(f"Unknown resampling method: {method}")

        batch, orig_h, orig_w, channels = image.shape
        multiple = int(round_to_multiple)
        if multiple < 1:
            raise ValueError("round_to_multiple must be positive")
        target_w = math.ceil(orig_w / multiple) * multiple
        target_h = math.ceil(orig_h / multiple) * multiple

        resized_w, resized_h = _resize_geometry(orig_w, orig_h, target_w, target_h, fit)
        if mask is None:
            # ComfyUI masks use zero for an unselected/unmasked area.
            mask_out = torch.zeros((batch, target_h, target_w), device=image.device, dtype=image.dtype)
        else:
            # ComfyUI masks are often single-channel batches. Broadcast a single
            # mask across image frames; otherwise require one mask per image.
            if mask.shape[0] == 1 and batch > 1:
                mask = mask.expand(batch, -1, -1)
            elif mask.shape[0] != batch:
                raise ValueError(f"Image batch is {batch}, but mask batch is {mask.shape[0]}")
            if mask.shape[-2:] != (orig_h, orig_w):
                mask = F.interpolate(mask.unsqueeze(1).float(), size=(orig_h, orig_w), mode="nearest").squeeze(1)
            mask_out = _fit_mask(mask, target_w, target_h, fit, resized_w, resized_h)

        pil_filter = _RESAMPLING[method]
        image_out = []
        for frame in image:
            frame_np = frame.detach().to(device="cpu", dtype=torch.float32).clamp(0, 1).numpy()
            frame_np = np.round(frame_np * 255).astype(np.uint8)
            if channels == 1:
                pil_image = Image.fromarray(frame_np[:, :, 0], mode="L")
            else:
                pil_image = Image.fromarray(frame_np)
            if pil_image.size != (resized_w, resized_h):
                pil_image = pil_image.resize((resized_w, resized_h), pil_filter)

            if fit == "crop":
                left = (resized_w - target_w) // 2
                top = (resized_h - target_h) // 2
                pil_image = pil_image.crop((left, top, left + target_w, top + target_h))
            elif fit == "letterbox":
                canvas = Image.new(pil_image.mode, (target_w, target_h), 0)
                left = (target_w - resized_w) // 2
                top = (target_h - resized_h) // 2
                canvas.paste(pil_image, (left, top))
                pil_image = canvas
            elif fit == "smart_fill":
                arr = np.asarray(pil_image)
                pad_w, pad_h = target_w - resized_w, target_h - resized_h
                left, top = pad_w // 2, pad_h // 2
                right, bottom = pad_w - left, pad_h - top
                yi = _reflection_indices(resized_h, top, bottom, torch.device("cpu")).numpy()
                xi = _reflection_indices(resized_w, left, right, torch.device("cpu")).numpy()
                arr = arr[yi][:, xi]
                pil_image = Image.fromarray(arr)

            arr = np.asarray(pil_image).astype(np.float32) / 255.0
            if channels == 1:
                arr = arr[:, :, None]
            image_out.append(torch.from_numpy(np.ascontiguousarray(arr)))

        image_out = torch.stack(image_out).to(device=image.device, dtype=image.dtype)
        if mask is not None:
            mask_out = mask_out.to(device=mask.device, dtype=mask.dtype)
        return (image_out, mask_out, target_w, target_h)


class TimeImageLoadDepthModel:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": (["depth_anything_v2_vits_fp16.safetensors", "depth_anything_v2_vitb_fp16.safetensors", "depth_anything_v2_vitl_fp16.safetensors"], {"default": "depth_anything_v2_vitl_fp16.safetensors"})}}

    RETURN_TYPES = ("TIMEIMAGE_DEPTH_MODEL",)
    FUNCTION = "load"
    CATEGORY = "Time AI/图像"

    def load(self, model):
        from huggingface_hub import hf_hub_download
        enc = "vits" if "vits" in model else "vitb" if "vitb" in model else "vitl"
        features, channels = {"vits": (64, [48,96,192,384]), "vitb": (128,[96,192,384,768]), "vitl": (256,[256,512,1024,1024])}[enc]
        path = os.path.join(folder_paths.models_dir, "Time-image", "depth", model)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if not os.path.exists(path):
            hf_hub_download("Kijai/DepthAnythingV2-safetensors", model, local_dir=os.path.dirname(path))
        net = DepthAnythingV2(encoder=enc, features=features, out_channels=channels)
        net.load_state_dict(load_torch_file(path), strict=False)
        net.eval()
        return ({"model": net, "dtype": torch.float16},)


class TimeImageDepth:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("TIMEIMAGE_DEPTH_MODEL",), "image": ("IMAGE",)}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "process"
    CATEGORY = "Time AI/图像"

    def process(self, model, image):
        device = mm.get_torch_device()
        net = model["model"].to(device)
        outs = []
        for frame in image:
            x = frame.permute(2,0,1).unsqueeze(0).to(device)
            h,w=x.shape[-2:]
            h14,w14=max(14,h-h%14),max(14,w-w%14)
            x=F.interpolate(x,size=(h14,w14),mode="bilinear",align_corners=False)
            x=(x-torch.tensor([.485,.456,.406],device=device).view(1,3,1,1))/torch.tensor([.229,.224,.225],device=device).view(1,3,1,1)
            with torch.no_grad(), torch.autocast(mm.get_autocast_device(device), dtype=torch.float16):
                d=net(x)
            d=F.interpolate(d.float(),size=(h,w),mode="bilinear",align_corners=False)
            d=(d-d.amin())/(d.amax()-d.amin()+1e-8)
            outs.append(d[0,0].cpu().unsqueeze(-1).expand(-1,-1,3))
        return (torch.stack(outs).float(),)


class TimePoseExtract:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",),
            "method": (["DWPose", "OpenPose"], {"default": "DWPose"}),
            "detect_body": (["enable", "disable"], {"default": "enable"}),
            "detect_hands": (["enable", "disable"], {"default": "enable"}),
            "detect_face": (["enable", "disable"], {"default": "enable"}),
            "resolution": ("INT", {"default": 512, "min": 128, "max": 2048, "step": 64}),
        }}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "extract"
    CATEGORY = "Time AI/图像"

    def extract(self, image, method, detect_body, detect_hands, detect_face, resolution):
        os.environ["AUX_ANNOTATOR_CKPTS_PATH"] = os.path.join(folder_paths.models_dir, "Time-image", "pose")
        from custom_controlnet_aux.open_pose import OpenposeDetector
        from custom_controlnet_aux.dwpose import DwposeDetector
        import numpy as np
        dev = mm.get_torch_device()
        if method == "OpenPose":
            detector = OpenposeDetector.from_pretrained().to(dev)
        else:
            detector = DwposeDetector.from_pretrained(
                "yzd-v/DWPose", "yzd-v/DWPose", det_filename="yolox_l.onnx",
                pose_filename="dw-ll_ucoco_384.onnx", torchscript_device=dev)
        outputs = []
        for frame in image:
            arr = (frame.detach().cpu().numpy().clip(0, 1) * 255).astype(np.uint8)
            result = detector(arr, detect_resolution=resolution,
                include_body=detect_body == "enable",
                include_hand=detect_hands == "enable",
                include_face=detect_face == "enable", output_type="np")
            outputs.append(torch.from_numpy(np.asarray(result).copy()).float() / 255.0)
        del detector
        return (torch.stack(outputs).to(image.device),)


AUTHOR = "Time AI"


NODE_CLASS_MAPPINGS = {
    "ImageMaskResolutionFixer": ImageMaskResolutionFixer,
    "TimeImageLoadDepthModel": TimeImageLoadDepthModel,
    "TimeImageDepth": TimeImageDepth,
    "TimePoseExtract": TimePoseExtract,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ImageMaskResolutionFixer": "Time・Res Fixer (Img/Mask)",
    "TimeImageLoadDepthModel": "Time Depth Model Loader",
    "TimeImageDepth": "Time Depth Extractor",
    "TimePoseExtract": "Time Pose Extractor",
}


