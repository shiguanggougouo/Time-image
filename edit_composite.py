"""Image-edit compositing helpers for Time image.

The node intentionally exposes only the two images that users need to connect.
Registration, color normalization, change detection and edge blending use fixed,
conservative defaults so the node stays simple to use.
"""

import math

import numpy as np
import torch

try:
    import cv2
except Exception as exc:  # Keep the whole custom-node pack loadable without OpenCV.
    cv2 = None
    _CV2_IMPORT_ERROR = exc
else:
    _CV2_IMPORT_ERROR = None


_MAX_ANALYSIS_EDGE = 1536


def _resize_for_analysis(image, max_edge=_MAX_ANALYSIS_EDGE):
    height, width = image.shape[:2]
    scale = min(1.0, max_edge / max(width, height))
    if scale >= 0.9999:
        return image
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    return cv2.resize(image, size, interpolation=cv2.INTER_AREA)


def _gray_for_features(rgb):
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    # CLAHE makes feature matching less sensitive to moderate exposure shifts.
    return cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)


def _estimate_homography(reference_rgb, edited_rgb):
    """Return a transform from edited-image coordinates to reference coordinates."""
    reference_gray = _gray_for_features(reference_rgb)
    edited_gray = _gray_for_features(edited_rgb)

    if hasattr(cv2, "SIFT_create"):
        detector = cv2.SIFT_create(nfeatures=5000, contrastThreshold=0.015)
        norm = cv2.NORM_L2
        ratio = 0.76
    else:
        detector = cv2.ORB_create(nfeatures=6000, fastThreshold=8)
        norm = cv2.NORM_HAMMING
        ratio = 0.80

    ref_points, ref_desc = detector.detectAndCompute(reference_gray, None)
    edit_points, edit_desc = detector.detectAndCompute(edited_gray, None)
    if ref_desc is None or edit_desc is None or len(ref_desc) < 8 or len(edit_desc) < 8:
        return None

    matcher = cv2.BFMatcher(norm)
    pairs = matcher.knnMatch(edit_desc, ref_desc, k=2)
    good = [first for first, second in pairs if first.distance < ratio * second.distance]
    if len(good) < 8:
        return None

    source = np.float32([edit_points[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    target = np.float32([ref_points[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    robust_method = getattr(cv2, "USAC_MAGSAC", cv2.RANSAC)
    transform, inliers = cv2.findHomography(
        source,
        target,
        robust_method,
        3.0,
        maxIters=10000,
        confidence=0.999,
    )
    if transform is None or inliers is None:
        return None
    inlier_count = int(inliers.sum())
    if inlier_count < 8 or inlier_count / len(good) < 0.12:
        return None
    if not np.isfinite(transform).all():
        return None

    # Reject unstable matches that would map the edited image far outside the
    # reference canvas. A plain resize is safer for those rare cases.
    edit_h, edit_w = edited_rgb.shape[:2]
    ref_h, ref_w = reference_rgb.shape[:2]
    corners = np.float32([[[0, 0], [edit_w, 0], [edit_w, edit_h], [0, edit_h]]])
    projected = cv2.perspectiveTransform(corners, transform)[0]
    area_ratio = abs(cv2.contourArea(projected)) / max(1.0, ref_w * ref_h)
    center = projected.mean(axis=0)
    if not (0.35 <= area_ratio <= 2.8):
        return None
    if not (-0.4 * ref_w <= center[0] <= 1.4 * ref_w and -0.4 * ref_h <= center[1] <= 1.4 * ref_h):
        return None
    return transform


def _full_resolution_transform(work_transform, source_size, target_size, source_work_size, target_work_size):
    source_w, source_h = source_size
    target_w, target_h = target_size
    source_work_w, source_work_h = source_work_size
    target_work_w, target_work_h = target_work_size
    source_scale = np.diag([source_work_w / source_w, source_work_h / source_h, 1.0])
    target_scale = np.diag([target_work_w / target_w, target_work_h / target_h, 1.0])
    return np.linalg.inv(target_scale) @ work_transform @ source_scale


def _structural_difference(reference_rgb, edited_rgb):
    """Estimate shape/edge changes while mostly ignoring global color shifts."""
    reference_l = cv2.cvtColor(reference_rgb, cv2.COLOR_RGB2LAB)[..., 0].astype(np.float32)
    edited_l = cv2.cvtColor(edited_rgb, cv2.COLOR_RGB2LAB)[..., 0].astype(np.float32)
    ref_x = cv2.Sobel(reference_l, cv2.CV_32F, 1, 0, ksize=3)
    ref_y = cv2.Sobel(reference_l, cv2.CV_32F, 0, 1, ksize=3)
    edit_x = cv2.Sobel(edited_l, cv2.CV_32F, 1, 0, ksize=3)
    edit_y = cv2.Sobel(edited_l, cv2.CV_32F, 0, 1, ksize=3)
    ref_mag = cv2.magnitude(ref_x, ref_y)
    edit_mag = cv2.magnitude(edit_x, edit_y)
    denom = ref_mag * edit_mag + 1e-5
    cosine = np.clip((ref_x * edit_x + ref_y * edit_y) / denom, -1.0, 1.0)
    # Edge direction is sign-insensitive: a small contrast inversion should not
    # by itself make every edge look like a new object.
    orientation_change = 1.0 - np.abs(cosine)
    relative_strength_change = np.abs(ref_mag - edit_mag) / (ref_mag + edit_mag + 24.0)
    both_flat = (ref_mag < 10.0) & (edit_mag < 10.0)
    only_one_edge = (np.maximum(ref_mag, edit_mag) > 18.0) & (np.minimum(ref_mag, edit_mag) < 6.0)
    difference = 0.55 * relative_strength_change + 0.45 * orientation_change
    difference[both_flat] = 0.0
    difference[only_one_edge] = np.maximum(difference[only_one_edge], 0.55)
    return np.clip(difference, 0.0, 1.0)


def _background_candidates(structural):
    # Select the structurally most stable majority as the color-match sample.
    # Limiting the sample prevents a small edited object from shifting the match.
    quantile = float(np.quantile(structural, 0.58))
    cutoff = min(0.30, max(0.12, quantile))
    candidates = structural <= cutoff
    if candidates.mean() < 0.08:
        candidates = structural <= float(np.quantile(structural, 0.35))
    return candidates


def _robust_lab_match(reference_rgb, edited_rgb, stable_mask):
    """Return a LAB affine color correction estimated from stable pixels."""
    reference_lab = cv2.cvtColor(reference_rgb, cv2.COLOR_RGB2LAB)
    edited_lab = cv2.cvtColor(edited_rgb, cv2.COLOR_RGB2LAB)
    stable_pixels = stable_mask.reshape(-1)
    indices = np.flatnonzero(stable_pixels)
    if indices.size < 256:
        indices = np.arange(stable_pixels.size)
    # Deterministic subsampling keeps high-resolution inputs quick and bounded.
    stride = max(1, int(math.ceil(indices.size / 250_000)))
    indices = indices[::stride]
    ref_flat = reference_lab.reshape(-1, 3)[indices].astype(np.float32)
    edit_flat = edited_lab.reshape(-1, 3)[indices].astype(np.float32)

    centers_ref = np.median(ref_flat, axis=0)
    centers_edit = np.median(edit_flat, axis=0)
    mad_ref = np.median(np.abs(ref_flat - centers_ref), axis=0) * 1.4826
    mad_edit = np.median(np.abs(edit_flat - centers_edit), axis=0) * 1.4826
    scale = np.clip(mad_ref / np.maximum(mad_edit, 2.0), 0.78, 1.28)
    # Avoid amplifying minor estimation noise when the images already match.
    scale = 1.0 + (scale - 1.0) * 0.75
    offset = centers_ref - centers_edit * scale

    corrected = edited_lab.astype(np.float32) * scale.reshape(1, 1, 3) + offset.reshape(1, 1, 3)
    corrected = np.clip(corrected, 0, 255).astype(np.uint8)
    return cv2.cvtColor(corrected, cv2.COLOR_LAB2RGB), (centers_ref, centers_edit, scale)


def _perceptual_difference(reference_rgb, edited_rgb):
    reference_lab = cv2.cvtColor(reference_rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    edited_lab = cv2.cvtColor(edited_rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    delta_l = (reference_lab[..., 0] - edited_lab[..., 0]) * (100.0 / 255.0)
    delta_a = reference_lab[..., 1] - edited_lab[..., 1]
    delta_b = reference_lab[..., 2] - edited_lab[..., 2]
    return np.sqrt(delta_l * delta_l + delta_a * delta_a + delta_b * delta_b)


def _remove_small_components(mask):
    count, labels, stats, _centroids = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    minimum_area = max(12, int(mask.size * 0.000006))
    keep = np.zeros(count, dtype=np.uint8)
    keep[0] = 0
    for label in range(1, count):
        if stats[label, cv2.CC_STAT_AREA] >= minimum_area:
            keep[label] = 1
    return keep[labels].astype(np.uint8)


def _make_change_mask(reference_rgb, corrected_rgb, structural):
    delta = _perceptual_difference(reference_rgb, corrected_rgb)
    stable = _background_candidates(structural)
    stable_delta = delta[stable]
    if stable_delta.size:
        median = float(np.median(stable_delta))
        mad = float(np.median(np.abs(stable_delta - median))) * 1.4826
    else:
        median, mad = 0.0, 0.0
    color_threshold = float(np.clip(median + 5.0 * mad, 7.5, 18.0))

    changed = (delta > color_threshold) | ((structural > 0.30) & (delta > 3.5))
    binary = changed.astype(np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    binary = _remove_small_components(binary)

    # Expand slightly before feathering, so the edited edge is not left as a
    # visible seam against the preserved original background.
    grow = max(2, round(max(reference_rgb.shape[:2]) / 700))
    kernel_size = grow * 2 + 1
    binary = cv2.dilate(binary, np.ones((kernel_size, kernel_size), np.uint8), iterations=1)
    sigma = max(0.8, max(reference_rgb.shape[:2]) / 1100.0)
    alpha = cv2.GaussianBlur(binary.astype(np.float32), (0, 0), sigmaX=sigma, sigmaY=sigma)
    return np.clip(alpha, 0.0, 1.0)


def _fallback_transform(source_size, target_size):
    source_w, source_h = source_size
    target_w, target_h = target_size
    return np.array(
        [[target_w / max(1, source_w), 0.0, 0.0],
         [0.0, target_h / max(1, source_h), 0.0],
         [0.0, 0.0, 1.0]],
        dtype=np.float64,
    )


def _composite_pair(reference_tensor, edited_tensor, control_mask=None, mask_feather=0):
    reference_channels = reference_tensor.shape[-1]
    reference = np.clip(reference_tensor.detach().to(device="cpu", dtype=torch.float32).numpy(), 0.0, 1.0)
    edited = np.clip(edited_tensor.detach().to(device="cpu", dtype=torch.float32).numpy(), 0.0, 1.0)
    reference_rgb = np.round(reference[..., :3] * 255.0).astype(np.uint8)
    edited_rgb = np.round(edited[..., :3] * 255.0).astype(np.uint8)
    if reference.shape[-1] == 1:
        reference_rgb = np.repeat(np.round(reference * 255.0).astype(np.uint8), 3, axis=2)
    if edited.shape[-1] == 1:
        edited_rgb = np.repeat(np.round(edited * 255.0).astype(np.uint8), 3, axis=2)

    target_h, target_w = reference_rgb.shape[:2]
    source_h, source_w = edited_rgb.shape[:2]
    ref_work = _resize_for_analysis(reference_rgb)
    edit_work = _resize_for_analysis(edited_rgb)
    target_work_h, target_work_w = ref_work.shape[:2]
    source_work_h, source_work_w = edit_work.shape[:2]

    transform_work = _estimate_homography(ref_work, edit_work)
    if transform_work is None:
        transform_work = _fallback_transform((source_work_w, source_work_h), (target_work_w, target_work_h))
    transform_full = _full_resolution_transform(
        transform_work,
        (source_w, source_h),
        (target_w, target_h),
        (source_work_w, source_work_h),
        (target_work_w, target_work_h),
    )

    aligned = cv2.warpPerspective(
        edited_rgb,
        transform_full,
        (target_w, target_h),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0),
    )
    valid = cv2.warpPerspective(
        np.full((source_h, source_w), 255, dtype=np.uint8),
        transform_full,
        (target_w, target_h),
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    ) > 0
    aligned_work = _resize_for_analysis(aligned)
    structural = _structural_difference(ref_work, aligned_work)
    stable = _background_candidates(structural)
    corrected_work, match = _robust_lab_match(ref_work, aligned_work, stable)

    # Apply the same robust color transform to the full-resolution image.
    ref_centers, edit_centers, scale = match
    aligned_lab = cv2.cvtColor(aligned, cv2.COLOR_RGB2LAB).astype(np.float32)
    offset = ref_centers - edit_centers * scale
    corrected_lab = aligned_lab * scale.reshape(1, 1, 3) + offset.reshape(1, 1, 3)
    corrected_lab = np.clip(corrected_lab, 0, 255).astype(np.uint8)
    corrected = cv2.cvtColor(corrected_lab, cv2.COLOR_LAB2RGB)

    alpha_work = _make_change_mask(ref_work, corrected_work, structural)
    alpha = cv2.resize(alpha_work, (target_w, target_h), interpolation=cv2.INTER_LINEAR)
    alpha = np.clip(alpha, 0.0, 1.0) * valid.astype(np.float32)

    base = reference_rgb.astype(np.float32) / 255.0
    edit = corrected.astype(np.float32) / 255.0
    repaired_rgb = base * (1.0 - alpha[..., None]) + edit * alpha[..., None]
    change_mask = alpha

    if control_mask is not None:
        # White selects where to apply the repair; black passes through the
        # geometrically aligned edited image instead of falling back to original.
        repair_region = np.clip(
            control_mask.detach().to(device="cpu", dtype=torch.float32).numpy(), 0.0, 1.0
        )
        if repair_region.shape != (target_h, target_w):
            repair_region = cv2.resize(
                repair_region, (target_w, target_h), interpolation=cv2.INTER_LINEAR
            )
        feather_px = max(0, int(mask_feather))
        if feather_px > 0:
            repair_region = cv2.GaussianBlur(
                repair_region,
                (0, 0),
                sigmaX=float(feather_px),
                sigmaY=float(feather_px),
            )
        repair_region = np.clip(repair_region, 0.0, 1.0)

        edited_passthrough = aligned.astype(np.float32) / 255.0
        edited_passthrough = np.where(valid[..., None], edited_passthrough, base)
        composite_rgb = (
            edited_passthrough * (1.0 - repair_region[..., None])
            + repaired_rgb * repair_region[..., None]
        )
        change_mask = alpha * repair_region
    else:
        composite_rgb = repaired_rgb

    composite_rgb = np.clip(composite_rgb, 0.0, 1.0)

    if reference_channels == 1:
        composite = cv2.cvtColor(np.round(composite_rgb * 255.0).astype(np.uint8), cv2.COLOR_RGB2GRAY)
        composite = (composite.astype(np.float32) / 255.0)[..., None]
    elif reference_channels == 4:
        composite = np.concatenate((composite_rgb, reference[..., 3:4]), axis=2)
    else:
        composite = composite_rgb
    return composite.astype(np.float32), change_mask.astype(np.float32)


class EditComposite:
    """Keep the original background while compositing detected image edits."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mask_feather": ("INT", {"default": 0, "min": 0, "max": 256, "step": 1}),
            },
            "optional": {
                "edited_image": ("IMAGE",),
                "original_image": ("IMAGE",),
                "mask": ("MASK",),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("composited_image", "change_mask")
    FUNCTION = "composite_edit"
    CATEGORY = "Time AI/图像"
    DESCRIPTION = "Align an AI edit, preserve unchanged areas, and optionally feather the control mask."
    SEARCH_ALIASES = ["offset repair", "edit composite", "preserve background", "change mask", "偏移修复", "图像编辑合成", "保留背景"]

    def composite_edit(self, original_image=None, edited_image=None, mask_feather=0, mask=None):
        # Allow this node to remain in a workflow with disconnected image inputs.
        # Pass through whichever image is available; return a 1x1 blank image if
        # both are disconnected so downstream nodes receive valid IMAGE/MASK data.
        available_image = edited_image if edited_image is not None else original_image
        if original_image is None or edited_image is None:
            if available_image is None:
                empty_image = torch.zeros((1, 1, 1, 3), dtype=torch.float32)
                empty_mask = torch.zeros((1, 1, 1), dtype=torch.float32)
                return (empty_image, empty_mask)
            empty_mask = torch.zeros(
                (available_image.shape[0], available_image.shape[1], available_image.shape[2]),
                device=available_image.device,
                dtype=available_image.dtype,
            )
            return (available_image, empty_mask)

        if cv2 is None:
            raise RuntimeError(
                "Time Offset Repair requires OpenCV (cv2). "
                "Install it in the ComfyUI Python environment and restart ComfyUI."
            ) from _CV2_IMPORT_ERROR
        if original_image.ndim != 4 or original_image.shape[-1] not in (1, 3, 4):
            raise ValueError("original_image must be a ComfyUI IMAGE batch shaped [B,H,W,C].")
        if edited_image.ndim != 4 or edited_image.shape[-1] not in (1, 3, 4):
            raise ValueError("edited_image must be a ComfyUI IMAGE batch shaped [B,H,W,C].")
        if mask is not None and mask.ndim != 3:
            raise ValueError("mask must be a ComfyUI MASK batch shaped [B,H,W].")

        original_batch = original_image.shape[0]
        edited_batch = edited_image.shape[0]
        if edited_batch == 1 and original_batch > 1:
            edited_image = edited_image.expand(original_batch, -1, -1, -1)
        elif original_batch == 1 and edited_batch > 1:
            original_image = original_image.expand(edited_batch, -1, -1, -1)
        elif original_batch != edited_batch:
            raise ValueError("Image batches must have the same length, or one input must contain a single image.")

        if mask is not None:
            if mask.shape[0] == 1 and original_image.shape[0] > 1:
                mask = mask.expand(original_image.shape[0], -1, -1)
            elif mask.shape[0] != original_image.shape[0]:
                raise ValueError("Mask batch must match the image batch, or contain a single mask.")

        composites = []
        masks = []
        mask_items = mask if mask is not None else [None] * original_image.shape[0]
        for reference, edited, control_mask in zip(original_image, edited_image, mask_items):
            composite, change_mask = _composite_pair(reference, edited, control_mask, mask_feather)
            composites.append(torch.from_numpy(np.ascontiguousarray(composite)))
            masks.append(torch.from_numpy(np.ascontiguousarray(change_mask)))

        composite_tensor = torch.stack(composites).to(device=original_image.device, dtype=original_image.dtype)
        mask_tensor = torch.stack(masks).to(device=original_image.device, dtype=original_image.dtype)
        return (composite_tensor, mask_tensor)
