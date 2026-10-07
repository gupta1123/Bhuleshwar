const MAX_IMAGE_EDGE = 2200;
const MAX_IMAGE_BYTES = 2_500_000;
const JPEG_QUALITY = 0.88;

function isProcessableImage(file: File) {
  return (
    file.type.startsWith("image/") &&
    file.type !== "image/gif" &&
    file.type !== "image/svg+xml"
  );
}

function isHeicLike(file: File) {
  return /image\/(heic|heif)/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
}

export function constrainImageDimensions(width: number, height: number, maxEdge = MAX_IMAGE_EDGE) {
  const longEdge = Math.max(width, height);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1, height: 1 };
  }

  if (longEdge <= maxEdge) {
    return { width, height };
  }

  const scale = maxEdge / longEdge;

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function getNormalizedFileName(fileName: string, extension: string) {
  const baseName = fileName.replace(/\.[^.]+$/, "") || "upload";
  return `${baseName}.${extension}`;
}

function loadImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new globalThis.Image();

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error(`Unable to read ${file.name}.`));
    };

    image.src = objectUrl;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number) {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, quality);
  });
}

export async function normalizeUploadImageFile(file: File): Promise<File> {
  if (!isProcessableImage(file)) {
    return file;
  }

  try {
    const image = await loadImage(file);
    const originalWidth = image.naturalWidth || image.width;
    const originalHeight = image.naturalHeight || image.height;
    const { width, height } = constrainImageDimensions(originalWidth, originalHeight);
    const needsResize = width !== originalWidth || height !== originalHeight;
    const needsNormalization = needsResize || file.size > MAX_IMAGE_BYTES || isHeicLike(file);

    if (!needsNormalization) {
      return file;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) {
      return file;
    }

    context.drawImage(image, 0, 0, width, height);

    const outputMimeType = file.type === "image/png" && !needsResize && file.size <= MAX_IMAGE_BYTES
      ? "image/png"
      : "image/jpeg";
    const blob = await canvasToBlob(
      canvas,
      outputMimeType,
      outputMimeType === "image/png" ? undefined : JPEG_QUALITY
    );

    if (!blob) {
      return file;
    }

    if (!needsResize && blob.size >= file.size && !isHeicLike(file)) {
      return file;
    }

    const extension = outputMimeType === "image/png" ? "png" : "jpg";
    return new File([blob], getNormalizedFileName(file.name, extension), {
      type: outputMimeType,
      lastModified: Date.now(),
    });
  } catch {
    return file;
  }
}

export async function normalizeUploadFiles(files?: FileList | File[] | null) {
  const normalized: File[] = [];

  for (const file of Array.from(files ?? [])) {
    normalized.push(await normalizeUploadImageFile(file));
  }

  return normalized;
}
