import { Bytes } from "firebase/firestore";

export function base64ToBytes(base64Data: string): Bytes | null {
  if (!base64Data) return null;
  const parts = base64Data.split(",");
  const base64Str = parts[1] || parts[0];
  try {
    return Bytes.fromBase64String(base64Str);
  } catch (e) {
    console.error("Failed to convert base64 to Bytes", e);
    return null;
  }
}

// Cache to prevent expensive base64 conversions on every render
const imageCache = new WeakMap<any, string>();
const stringImageCache = new Map<string, string>();
// Keep decoded HTMLImageElement instances alive in memory so Android WebView / Blink
// never evicts decoded product bitmaps when switching modals or tabs.
const predecodedImageElements = new Map<string, HTMLImageElement>();

export function preloadImageUrl(url: string | undefined): void {
  if (!url || typeof window === "undefined") return;
  if (predecodedImageElements.has(url)) return;
  try {
    // Cap cache size to prevent unbounded memory growth while covering full catalog
    if (predecodedImageElements.size > 300) {
      const oldestKey = predecodedImageElements.keys().next().value;
      if (oldestKey) predecodedImageElements.delete(oldestKey);
    }
    const img = new Image();
    img.decoding = "sync";
    img.loading = "eager";
    img.src = url;
    if (typeof img.decode === "function") {
      img.decode().catch(() => {});
    }
    predecodedImageElements.set(url, img);
  } catch {}
}

export function preloadProductImages(products: Array<{ image?: any }>): void {
  if (!Array.isArray(products) || typeof window === "undefined") return;
  for (const p of products) {
    if (p?.image) {
      const url = getImageUrl(p.image);
      if (url) preloadImageUrl(url);
    }
  }
}

export function getImageUrl(imageField: any): string | undefined {
  if (!imageField) return undefined;
  if (typeof imageField === "string") {
    if (imageField.startsWith("blob:") || imageField.trim() === "")
      return undefined;
    const cached = stringImageCache.get(imageField);
    if (cached) return cached;
    const resolved =
      imageField.startsWith("data:") ||
      imageField.startsWith("http://") ||
      imageField.startsWith("https://") ||
      imageField.startsWith("/")
        ? imageField
        : `data:image/webp;base64,${imageField}`;
    stringImageCache.set(imageField, resolved);
    preloadImageUrl(resolved);
    return resolved;
  }

  // Use cached base64 string if we already processed this Bytes object
  if (typeof imageField === "object" && imageCache.has(imageField)) {
    return imageCache.get(imageField);
  }

  // Handle serialized Firestore Bytes from JSON or localStorage
  if (imageField && typeof imageField === "object" && typeof imageField.bytes === "string") {
    const dataUrl = "data:image/webp;base64," + imageField.bytes;
    imageCache.set(imageField, dataUrl);
    preloadImageUrl(dataUrl);
    return dataUrl;
  }

  if (imageField && typeof imageField.toBase64 === "function") {
    try {
      const dataUrl = "data:image/webp;base64," + imageField.toBase64();
      if (typeof imageField === "object") imageCache.set(imageField, dataUrl);
      preloadImageUrl(dataUrl);
      return dataUrl;
    } catch (e) {
      console.error("Failed to convert Bytes to Base64", e);
      return undefined;
    }
  }
  if (imageField && typeof imageField.toUint8Array === "function") {
    // Fallback if toBase64 is not available
    try {
      const uint8Array = imageField.toUint8Array();
      // Extremely basic, safe base64 conversion from Uint8Array
      let binary = "";
      const len = uint8Array.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(uint8Array[i]);
      }
      const dataUrl = "data:image/webp;base64," + btoa(binary);
      if (typeof imageField === "object") imageCache.set(imageField, dataUrl);
      preloadImageUrl(dataUrl);
      return dataUrl;
    } catch (e) {
      console.error("Failed to convert Bytes array to Base64", e);
      return undefined;
    }
  }
  return undefined;
}

export async function resizeImage(
  file: File,
  maxWidth: number = 360,
  maxHeight: number = 360
): Promise<string> {
  // Method 1: High-performance createImageBitmap with hardware downsampling
  if (typeof window !== "undefined" && "createImageBitmap" in window) {
    try {
      const bitmap = await createImageBitmap(file);
      let width = bitmap.width;
      let height = bitmap.height;
      const maxDim = Math.max(maxWidth, maxHeight);
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round(height * (maxDim / width));
          width = maxDim;
        } else {
          width = Math.round(width * (maxDim / height));
          height = maxDim;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, width);
      canvas.height = Math.max(1, height);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, width, height);
      }
      bitmap.close?.();
      try {
        const webp = canvas.toDataURL("image/webp", 0.75);
        if (webp.startsWith("data:image/webp")) return webp;
      } catch (_) {}
      return canvas.toDataURL("image/jpeg", 0.75);
    } catch (bitmapErr) {
      console.warn("createImageBitmap fallback to ObjectURL:", bitmapErr);
    }
  }

  // Method 2: Blob URL (avoids giant base64 memory allocation)
  return new Promise((resolve, reject) => {
    let objectUrl: string | null = null;
    try {
      objectUrl = URL.createObjectURL(file);
    } catch (_) {}

    const img = new Image();
    img.onload = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      let width = img.width || 300;
      let height = img.height || 300;
      const maxDim = Math.max(maxWidth, maxHeight);
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round(height * (maxDim / width));
          width = maxDim;
        } else {
          width = Math.round(width * (maxDim / height));
          height = maxDim;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, width);
      canvas.height = Math.max(1, height);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, width, height);
      }
      try {
        const webp = canvas.toDataURL("image/webp", 0.75);
        if (webp.startsWith("data:image/webp")) {
          resolve(webp);
          return;
        }
      } catch (_) {}
      try {
        resolve(canvas.toDataURL("image/jpeg", 0.75));
      } catch (err) {
        reject(err);
      }
    };

    img.onerror = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      // Method 3: FileReader fallback
      const reader = new FileReader();
      reader.onload = (e) => {
        const fallbackImg = new Image();
        fallbackImg.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = Math.min(maxWidth, fallbackImg.width || maxWidth);
          canvas.height = Math.min(maxHeight, fallbackImg.height || maxHeight);
          const ctx = canvas.getContext("2d");
          if (ctx) ctx.drawImage(fallbackImg, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.75));
        };
        fallbackImg.onerror = () => reject(new Error("Unable to decode image"));
        fallbackImg.src = e.target?.result as string;
      };
      reader.onerror = () => reject(new Error("Failed reading image file"));
      reader.readAsDataURL(file);
    };

    if (objectUrl) {
      img.src = objectUrl;
    } else {
      const reader = new FileReader();
      reader.onload = (e) => {
        img.src = e.target?.result as string;
      };
      reader.onerror = (err) => reject(err);
      reader.readAsDataURL(file);
    }
  });
}

export async function compressProfileImage(file: File | Blob | string): Promise<string> {
  const targetSize = 256; // Crisp avatar resolution, minimal memory on Android

  // If already a data URL, we can load it directly into an Image element
  if (typeof file === "string") {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const width = img.naturalWidth || img.width || targetSize;
          const height = img.naturalHeight || img.height || targetSize;
          const minDim = Math.min(width, height);
          const startX = (width - minDim) / 2;
          const startY = (height - minDim) / 2;

          const canvas = document.createElement("canvas");
          canvas.width = targetSize;
          canvas.height = targetSize;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(img, startX, startY, minDim, minDim, 0, 0, targetSize, targetSize);
          }
          resolve(canvas.toDataURL("image/jpeg", 0.82));
        } catch (err) {
          console.warn("Direct string image canvas crop failed, returning input string:", err);
          resolve(file);
        }
      };
      img.onerror = () => {
        // If it's already a valid base64 data URL, return it directly
        if (file.startsWith("data:image")) {
          resolve(file);
        } else {
          reject(new Error("Unable to decode image source"));
        }
      };
      img.src = file;
    });
  }

  // Method 1: Hardware-accelerated createImageBitmap with EXIF orientation (zero-copy on Android)
  if (typeof window !== "undefined" && "createImageBitmap" in window) {
    try {
      let bitmap: ImageBitmap | null = null;
      try {
        // Try with standard EXIF auto-orientation
        bitmap = await (createImageBitmap as any)(file, { imageOrientation: "from-image" });
      } catch (_) {
        // Fallback without options for WebViews that don't support the options dictionary
        bitmap = await createImageBitmap(file);
      }

      if (bitmap) {
        const width = bitmap.width || targetSize;
        const height = bitmap.height || targetSize;
        const minDim = Math.min(width, height);
        const startX = (width - minDim) / 2;
        const startY = (height - minDim) / 2;

        const canvas = document.createElement("canvas");
        canvas.width = targetSize;
        canvas.height = targetSize;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(
            bitmap,
            startX,
            startY,
            minDim,
            minDim,
            0,
            0,
            targetSize,
            targetSize
          );
        }
        bitmap.close?.();

        try {
          const webp = canvas.toDataURL("image/webp", 0.82);
          if (webp.startsWith("data:image/webp")) return webp;
        } catch (_) {}

        return canvas.toDataURL("image/jpeg", 0.82);
      }
    } catch (e) {
      console.warn("createImageBitmap failed, falling back to FileReader:", e);
    }
  }

  // Method 2: Robust FileReader to base64 DataURL (most reliable in Android WebView)
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (readerEvent) => {
      const dataUrl = readerEvent.target?.result as string;
      if (!dataUrl) {
        reject(new Error("Unable to read selected image file"));
        return;
      }

      const img = new Image();
      img.onload = () => {
        try {
          const width = img.naturalWidth || img.width || targetSize;
          const height = img.naturalHeight || img.height || targetSize;
          const minDim = Math.min(width, height);
          const startX = (width - minDim) / 2;
          const startY = (height - minDim) / 2;

          const canvas = document.createElement("canvas");
          canvas.width = targetSize;
          canvas.height = targetSize;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(img, startX, startY, minDim, minDim, 0, 0, targetSize, targetSize);
          }

          try {
            const webp = canvas.toDataURL("image/webp", 0.82);
            if (webp.startsWith("data:image/webp")) {
              resolve(webp);
              return;
            }
          } catch (_) {}

          resolve(canvas.toDataURL("image/jpeg", 0.82));
        } catch (canvasErr) {
          console.warn("Canvas crop failed, returning dataUrl directly:", canvasErr);
          resolve(dataUrl);
        }
      };

      img.onerror = (imgErr) => {
        console.warn("Image load error on FileReader dataUrl:", imgErr);
        // If dataUrl is a valid image data string, resolve it rather than failing
        if (dataUrl.startsWith("data:image")) {
          resolve(dataUrl);
        } else {
          reject(new Error("Could not parse image file format"));
        }
      };

      img.src = dataUrl;
    };

    reader.onerror = (readErr) => {
      console.error("FileReader failed to read image file:", readErr);
      reject(new Error("Failed to read image from device storage"));
    };

    reader.readAsDataURL(file);
  });
}
