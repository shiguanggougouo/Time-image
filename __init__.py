import math

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image


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


NODE_CLASS_MAPPINGS = {
    "ImageMaskResolutionFixer": ImageMaskResolutionFixer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ImageMaskResolutionFixer": "Time・Res Fixer (Img/Mask)",
}
