import torch
from PIL import Image
from transformers import AutoModelForCausalLM, AutoProcessor

from .caption import clean_caption, default_long_prompt, default_replacements


class Florence2ImageProcessor:
    def __init__(self, device: str = "cuda"):
        self.device = device
        self.model = None
        self.processor = None
        self.is_loaded = False

    def load_model(self):
        model_path = "multimodalart/Florence-2-large-no-flash-attn"
        torch_dtype = torch.float16

        self.model = AutoModelForCausalLM.from_pretrained(
            model_path,
            torch_dtype=torch_dtype,
            trust_remote_code=True,
        ).to(self.device)
        self.processor = AutoProcessor.from_pretrained(model_path, trust_remote_code=True)
        self.is_loaded = True

    def generate_caption(
        self,
        image: Image,
        prompt: str = default_long_prompt,
        replacements=default_replacements,
        max_new_tokens: int = 1024,
    ):
        if not self.is_loaded:
            self.load_model()

        task_prompt = "<DETAILED_CAPTION>"
        inputs = self.processor(text=task_prompt, images=image, return_tensors="pt").to(
            self.device, torch.float16
        )

        generated_ids = self.model.generate(
            input_ids=inputs["input_ids"],
            pixel_values=inputs["pixel_values"],
            max_new_tokens=max_new_tokens,
            num_beams=3,
        )

        generated_text = self.processor.batch_decode(generated_ids, skip_special_tokens=False)[0]
        parsed = self.processor.post_process_generation(
            generated_text, task=task_prompt, image_size=(image.width, image.height)
        )
        caption_text = parsed.get("<DETAILED_CAPTION>", "")
        caption_text = caption_text.replace("The image shows ", "")
        caption_text = caption_text.replace("the image shows ", "")
        caption_text = clean_caption(caption_text, replacements=replacements)
        return caption_text
