import math
import json
import re

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
import nodes
from .edit_composite import EditComposite
from .play_sound import PlaySound
from .gguf_loader import TimeGGUFLoader
from .text_label import TimeTextLabel


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
    "9:16": (9, 16), "2:1": (2, 1), "1:2": (1, 2),
    "21:9": (21, 9), "9:21": (9, 21),
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
                "resolution_mode": (["边长像素", "自定义宽高", "百万像素"], {"default": "边长像素"}),
                "megapixels": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 32.0, "step": 0.1}),
                "round_to_multiple": (["OFF", 8, 16, 32, 64], {"default": 32}),
                "enable_images": ("BOOLEAN", {"default": False}),
                "limit_image_max_edge": ("BOOLEAN", {"default": False}),
                "image_max_edge": ([512, 640, 768, 896, 1024, 1280, 1536, 1792, 2048, 2560, 3072, 4096], {"default": 2048}),
                "enable_resolution": ("BOOLEAN", {"default": False}),
                "use_image1_resolution": ("BOOLEAN", {"default": False}),
                "image_snap_multiple": (["OFF", 8, 16, 32, 64], {"default": "OFF"}),
                "images": ("STRING", {"default": "", "multiline": True}),
                # Appended to preserve widget ordering in workflows created by 2.1.x.
                "custom_width": ("INT", {"default": 1024, "min": 1, "max": 32768, "step": 1}),
                "custom_height": ("INT", {"default": 1024, "min": 1, "max": 32768, "step": 1}),
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
              use_image1_resolution=False, image_snap_multiple="OFF", images="",
              custom_width=1024, custom_height=1024):
        if aspect_ratio not in _ASPECTS:
            raise ValueError(f"Unknown aspect ratio: {aspect_ratio}")
        if resolution_mode not in ("边长像素", "百万像素", "自定义宽高"):
            raise ValueError(f"Unknown resolution mode: {resolution_mode}")
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
            if enable_resolution and resolution_mode == "自定义宽高":
                width = max(1, int(custom_width))
                height = max(1, int(custom_height))
            elif enable_resolution and resolution_mode == "百万像素":
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


_PANORAMA_VIEW_YAWS = (0.0, math.pi / 2, math.pi, -math.pi / 2)


def _render_panorama_view(image, yaw, pitch, fov, aspect, output_width=1024):
    """Project an equirectangular IMAGE batch into a rectilinear camera view."""
    batch, source_height, source_width, _channels = image.shape
    output_width = max(64, min(4096, int(output_width)))
    aspect = max(0.5, min(3.0, float(aspect)))
    output_height = max(64, min(4096, round(output_width / aspect)))
    fov = max(12.0, min(150.0, float(fov)))
    device = image.device

    screen_x = (2 * (torch.arange(output_width, device=device, dtype=torch.float32) + 0.5) / output_width - 1)
    screen_y = (1 - 2 * (torch.arange(output_height, device=device, dtype=torch.float32) + 0.5) / output_height)
    grid_x, grid_y = torch.meshgrid(screen_x, screen_y, indexing="xy")
    focal = math.tan(math.radians(fov) * 0.5)
    ray_x = grid_x * aspect * focal
    ray_y = grid_y * focal
    ray_z = torch.ones_like(ray_x)
    ray_length = torch.sqrt(ray_x.square() + ray_y.square() + ray_z.square()).clamp_min(1e-8)
    ray_x, ray_y, ray_z = ray_x / ray_length, ray_y / ray_length, ray_z / ray_length

    cp, sp = math.cos(pitch), math.sin(pitch)
    ray_y2 = cp * ray_y - sp * ray_z
    ray_z2 = sp * ray_y + cp * ray_z
    cy, sy = math.cos(yaw), math.sin(yaw)
    ray_x2 = cy * ray_x + sy * ray_z2
    ray_z3 = -sy * ray_x + cy * ray_z2

    u = torch.atan2(ray_x2, ray_z3) / (2 * math.pi) + 0.5
    v = 0.5 + torch.asin(ray_y2.clamp(-1, 1)) / math.pi
    sample_x = 2 * (u * source_width + 1) / (source_width + 2) - 1
    sample_y = 1 - 2 * v
    grid = torch.stack((sample_x, sample_y), dim=-1).unsqueeze(0).expand(batch, -1, -1, -1)

    source = image.to(dtype=torch.float32).movedim(-1, 1)
    # Circular horizontal padding prevents a seam at the 0/360-degree boundary.
    source = torch.cat((source[..., -1:], source, source[..., :1]), dim=-1)
    view = F.grid_sample(source, grid, mode="bilinear", padding_mode="border", align_corners=False)
    return view.movedim(1, -1).to(device=image.device, dtype=image.dtype)


class PanoramaViewer:
    """Interactively inspect an equirectangular panorama and output a selected view."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "multi_view": ("BOOLEAN", {"default": False}),
                "selected_view": ("INT", {"default": 0, "min": 0, "max": 3, "step": 1}),
                "camera_yaw": ("FLOAT", {"default": 0.0, "min": -100.0, "max": 100.0, "step": 0.01}),
                "camera_pitch": ("FLOAT", {"default": 0.0, "min": -1.5708, "max": 1.5708, "step": 0.01}),
                "camera_fov": ("FLOAT", {"default": 82.0, "min": 12.0, "max": 150.0, "step": 0.1}),
                "view_aspect": ("FLOAT", {"default": 1.6, "min": 0.5, "max": 3.0, "step": 0.01}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "view_panorama"
    CATEGORY = "Time AI/图像"
    OUTPUT_NODE = True
    DESCRIPTION = "View a panorama and output the current camera view or one of four selectable directions."
    SEARCH_ALIASES = ["panorama", "360 panorama", "equirectangular", "multi view", "全景图", "多视角"]

    def view_panorama(self, image, multi_view=False, selected_view=0, camera_yaw=0.0,
                      camera_pitch=0.0, camera_fov=82.0, view_aspect=1.6):
        if image.ndim != 4 or image.shape[-1] not in (1, 3, 4):
            raise ValueError(f"Expected IMAGE [B,H,W,C] with 1, 3, or 4 channels; got {tuple(image.shape)}")

        selected_view = max(0, min(3, int(selected_view)))
        if multi_view:
            yaw = _PANORAMA_VIEW_YAWS[selected_view]
            pitch = 0.0
        else:
            yaw = float(camera_yaw)
            pitch = max(-math.pi / 2, min(math.pi / 2, float(camera_pitch)))
        aspect = max(0.5, min(3.0, float(view_aspect)))
        fov = max(12.0, min(150.0, float(camera_fov)))

        preview = image[:1, ..., :3]
        if image.shape[-1] == 1:
            preview = image[:1].repeat(1, 1, 1, 3)
        height, width = preview.shape[1:3]
        longest_edge = max(width, height)
        if longest_edge > 2048:
            scale = 2048 / longest_edge
            preview = F.interpolate(
                preview.movedim(-1, 1),
                size=(max(1, round(height * scale)), max(1, round(width * scale))),
                mode="bilinear", align_corners=False, antialias=True,
            ).movedim(1, -1)

        panorama_saved = nodes.PreviewImage().save_images(preview.detach().to(device="cpu", dtype=torch.float32).clamp(0, 1).contiguous())
        view = _render_panorama_view(image, yaw, pitch, fov, aspect)
        preview_views = []
        thumb_width = 256
        thumb_height = max(64, round(thumb_width / aspect))
        for view_yaw in _PANORAMA_VIEW_YAWS:
            thumbnail = _render_panorama_view(image[:1], view_yaw, 0.0, fov, aspect, output_width=thumb_width)
            preview_views.extend(nodes.PreviewImage().save_images(thumbnail.detach().to(device="cpu", dtype=torch.float32).clamp(0, 1).contiguous())["ui"]["images"])

        return {
            "ui": {
                "panorama": panorama_saved["ui"]["images"],
                "views": preview_views,
            },
            "result": (view,),
        }

class CacheCleaner:
    """Schedule ComfyUI's native cache cleanup after the current prompt finishes."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clear_model_cache": ("BOOLEAN", {"default": False}),
                "clear_other_cache": ("BOOLEAN", {"default": False}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("status",)
    FUNCTION = "clean_cache"
    CATEGORY = "Time AI/工具"
    OUTPUT_NODE = True
    DESCRIPTION = "Schedule model or node execution-cache cleanup after the current workflow finishes."
    SEARCH_ALIASES = ["cache cleaner", "clear cache", "清理缓存", "缓存清理"]

    def clean_cache(self, clear_model_cache=False, clear_other_cache=False):
        if not clear_model_cache and not clear_other_cache:
            return ("No cache cleanup selected.",)

        # Let ComfyUI's worker perform cleanup after this workflow has finished.
        # Set the model flag explicitly to False when clearing execution cache:
        # ComfyUI otherwise treats free_memory as a request to unload models too.
        from server import PromptServer

        prompt_server = PromptServer.instance
        prompt_queue = getattr(prompt_server, "prompt_queue", None)
        if prompt_queue is None:
            raise RuntimeError("ComfyUI prompt queue is unavailable; cache cleanup could not be scheduled.")

        prompt_queue.set_flag("unload_models", bool(clear_model_cache))
        if clear_other_cache:
            prompt_queue.set_flag("free_memory", True)

        actions = []
        if clear_model_cache:
            actions.append("unload managed models")
        if clear_other_cache:
            actions.append("clear execution cache and unused memory")
        return ("Scheduled after workflow: " + " + ".join(actions),)


NODE_CLASS_MAPPINGS = {
    "PromptImageResolution": PromptImageResolution,
    "ImageMaskResolutionFixer": ImageMaskResolutionFixer,
    "PanoramaViewer": PanoramaViewer,
    "CacheCleaner": CacheCleaner,
    "EditComposite": EditComposite,
    "PlaySound": PlaySound,
    "TimeGGUFLoader": TimeGGUFLoader,
    "TimeTextLabel": TimeTextLabel,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ImageMaskResolutionFixer": "Time・Res Fixer (Img/Mask)",
    "PromptImageResolution": "Time・Prompt + Images + Resolution",
    "PanoramaViewer": "Time・Panorama Viewer",
    "CacheCleaner": "Time・Cache Cleaner",
    "EditComposite": "Time・Offset Repair",
    "PlaySound": "Time・Play Sound",
    "TimeGGUFLoader": "Time・GGUF UNET Loader",
    "TimeTextLabel": "Time・文字标签",
}

WEB_DIRECTORY = "./web"
