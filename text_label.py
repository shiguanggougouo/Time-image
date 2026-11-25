class TimeTextLabel:
    """Canvas annotation node; the browser extension renders and edits its label."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "双击编辑文字", "multiline": True}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "keep_label"
    CATEGORY = "Time AI/工具"
    DESCRIPTION = "A canvas label. Double-click the text to edit it; right-click for font properties."

    def keep_label(self, text):
        return ()
