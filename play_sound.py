class PlaySound:
    """Play a short completion chime in the ComfyUI browser."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "volume": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "play_sound"
    CATEGORY = "Time AI/工具"
    OUTPUT_NODE = True
    DESCRIPTION = "Play a short completion chime in the ComfyUI browser."
    SEARCH_ALIASES = ["play sound", "completion sound", "notification sound", "播放声音", "完成提示音"]

    def play_sound(self, image, volume=0.5):
        volume = max(0.0, min(1.0, float(volume)))
        return {"ui": {"sound": ["complete", volume]}, "result": ()}
