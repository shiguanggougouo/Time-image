import math
import json
import re

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
import nodes


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
    """Time image node: resize image and mask together to divisible dimensions."""

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


_ASPECTS = {
    "1:1": (1, 1), "3:2": (3, 2), "2:3": (2, 3),
    "4:3": (4, 3), "3:4": (3, 4), "16:9": (16, 9),
    "9:16": (9, 16), "21:9": (21, 9), "9:21": (9, 21),
}


class PromptImageResolution:
    """Compact prompt, up to ten optional images, and output-size selector."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {"multiline": True, "default": ""}),
                "aspect_ratio": (list(_ASPECTS), {"default": "1:1"}),
                "edge_limit": (["最小边", "最大边"], {"default": "最大边"}),
                "edge_resolution": ("INT", {"default": 1024, "min": 64, "max": 16384, "step": 1}),
                "resolution_mode": (["边长像素", "百万像素"], {"default": "边长像素"}),
                "megapixels": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 32.0, "step": 0.1}),
                "round_to_multiple": (["OFF", 8, 16, 32, 64], {"default": 32}),
                "enable_images": ("BOOLEAN", {"default": False}),
                "limit_image_max_edge": ("BOOLEAN", {"default": False}),
                "image_max_edge": ([512, 640, 768, 896, 1024, 1280, 1536, 1792, 2048, 2560, 3072, 4096], {"default": 2048}),
                "enable_resolution": ("BOOLEAN", {"default": False}),
                "use_image1_resolution": ("BOOLEAN", {"default": False}),
                "image_snap_multiple": (["OFF", 8, 16, 32, 64], {"default": "OFF"}),
                "images": ("STRING", {"default": "", "multiline": True}),
            },
        }

    RETURN_TYPES = ("INT", "INT", "STRING") + ("IMAGE",) * 10
    RETURN_NAMES = ("width", "height", "prompt") + tuple(f"image_{i}" for i in range(1, 11))
    FUNCTION = "build"
    CATEGORY = "Time AI/图像"

    def build(self, prompt, aspect_ratio, edge_limit, edge_resolution,
              resolution_mode="边长像素", megapixels=1.0, round_to_multiple=32,
              enable_images=False, limit_image_max_edge=False,
              image_max_edge=2048, enable_resolution=False,
              use_image1_resolution=False, image_snap_multiple="OFF", images=""):
        if aspect_ratio not in _ASPECTS:
            raise ValueError(f"Unknown aspect ratio: {aspect_ratio}")
        if round_to_multiple != "OFF" and int(round_to_multiple) not in (8, 16, 32, 64):
            raise ValueError("分辨率对齐倍数必须是 OFF、8、16、32 或 64。")
        try:
            image_items = json.loads(images) if images else []
        except (TypeError, json.JSONDecodeError):
            image_items = [{"name": name, "enabled": True} for name in images.splitlines() if name.strip()]
        image_items = image_items[:10]
        loaded = []
        first_image = None
        for index, item in enumerate(image_items):
            enabled = bool(item.get("enabled", True))
            needs_for_resolution = enable_resolution and use_image1_resolution and index == 0
            tensor = None
            if (enable_images and enabled) or needs_for_resolution:
                tensor, _mask = nodes.LoadImage().load_image(item["name"])
                if limit_image_max_edge and enable_images:
                    tensor = self._limit_long_edge(tensor, int(image_max_edge))
                if enable_images and image_snap_multiple != "OFF":
                    snap = int(image_snap_multiple)
                    if snap not in (8, 16, 32, 64):
                        raise ValueError("图像对齐倍数必须是 OFF、8、16、32 或 64。")
                    tensor, _mask, _, _ = ImageMaskResolutionFixer().resize_image_mask(
                        tensor, fit="smart_fill", method="lanczos", round_to_multiple=snap,
                    )
            if index == 0:
                first_image = tensor
            if enable_images:
                loaded.append(tensor if enabled else None)

        if enable_resolution and use_image1_resolution:
            if first_image is None:
                raise ValueError("启用‘使用图像 1 分辨率’时，请先导入图像 1。")
            height, width = first_image.shape[1:3]
        else:
            ratio_w, ratio_h = _ASPECTS[aspect_ratio] if enable_resolution else (1, 1)
            ratio = ratio_w / ratio_h
            multiple = round_to_multiple if enable_resolution else 32
            if enable_resolution and resolution_mode == "百万像素":
                area = max(0.1, float(megapixels)) * 1_000_000
                width = math.sqrt(area * ratio)
                height = width / ratio
            else:
                edge = int(edge_resolution) if enable_resolution else 1024
                if enable_resolution and edge_limit == "最小边":
                    width, height = (edge * ratio, edge) if ratio >= 1 else (edge, edge / ratio)
                else:
                    width, height = (edge, edge / ratio) if ratio >= 1 else (edge * ratio, edge)
            if multiple == "OFF":
                width = max(1, int(math.floor(width + 0.5)))
                height = max(1, int(math.floor(height + 0.5)))
            else:
                multiple = int(multiple)
                width = max(multiple, int(math.floor(width / multiple + 0.5)) * multiple)
                height = max(multiple, int(math.floor(height / multiple + 0.5)) * multiple)
        prompt = re.sub(r"@图(?:像)?\s*(\d+)", r"<Picture \1>", prompt)
        # Outputs keep stable slot positions; unused image outputs are None.
        return (width, height, prompt, *(loaded + [None] * (10 - len(loaded))))

    @staticmethod
    def _limit_long_edge(image, max_edge):
        if max_edge < 1:
            raise ValueError("图像最大边必须大于 0")
        height, width = image.shape[1:3]
        long_edge = max(width, height)
        if long_edge <= max_edge:
            return image
        scale = max_edge / long_edge
        target_width = max(1, int(round(width * scale)))
        target_height = max(1, int(round(height * scale)))
        resized = F.interpolate(
            image.movedim(-1, 1), size=(target_height, target_width),
            mode="bicubic", align_corners=False, antialias=True,
        ).movedim(1, -1)
        return resized.clamp(0, 1)


NODE_CLASS_MAPPINGS = {
    "ImageMaskResolutionFixer": ImageMaskResolutionFixer,
    "PromptImageResolution": PromptImageResolution,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ImageMaskResolutionFixer": "Time・Res Fixer (Img/Mask)",
    "PromptImageResolution": "Time・Prompt + Images + Resolution",
}

WEB_DIRECTORY = "./web"
