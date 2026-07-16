export interface ImageAttachment { name: string; mediaType: "image/jpeg" | "image/png" | "image/webp"; dataUrl: string }
const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
export function validateAttachments(value: unknown, visionEnabled: boolean): ImageAttachment[] {
	if (!Array.isArray(value)) return [];
	if (value.length > 4) throw new Error("Attach no more than four images");
	const result = value.map((item) => {
		if (!item || typeof item !== "object") throw new Error("Invalid image attachment");
		const candidate = item as Record<string, unknown>;
		const mediaType = String(candidate.mediaType);
		const dataUrl = String(candidate.dataUrl);
		if (!allowed.has(mediaType)) throw new Error("Images must be JPEG, PNG, or WebP");
		if (!dataUrl.startsWith(`data:${mediaType};base64,`)) throw new Error("Invalid image data");
		if (dataUrl.length > 8_000_000) throw new Error("Each image must be smaller than 6 MB");
		return { name: String(candidate.name || "image"), mediaType: mediaType as ImageAttachment["mediaType"], dataUrl };
	});
	if (result.length && !visionEnabled) throw new Error("The active model cannot process images. Change models or remove the attachment.");
	return result;
}
export function userContent(prompt: string, attachments: ImageAttachment[]) {
	if (!attachments.length) return prompt;
	return [{ type: "text", text: prompt }, ...attachments.map((attachment) => ({ type: "image_url", image_url: { url: attachment.dataUrl } }))];
}
