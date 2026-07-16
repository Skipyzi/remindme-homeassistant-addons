(function exposeAttachments(globalScope) {
  async function addFiles(app, files) {
    for (const file of [...files].slice(0, 4 - app.attachments.length)) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { app.attachmentError = "Use JPEG, PNG, or WebP images."; continue; }
      if (file.size > 6_000_000) { app.attachmentError = "Each image must be smaller than 6 MB."; continue; }
      const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
      app.attachments.push({ name: file.name, mediaType: file.type, dataUrl });
    }
    if (app.attachments.length && !app.visionEnabled) app.attachmentError = "The active model cannot process images. Change models or remove the attachment.";
  }
  globalScope.RemindMeAttachments = { addFiles };
})(window);
