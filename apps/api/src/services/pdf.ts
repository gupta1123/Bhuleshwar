let pdfjsLibPromise: Promise<typeof import("pdfjs-dist/legacy/build/pdf")> | null = null;

async function loadPdfJs() {
  if (typeof window === "undefined") {
    throw new Error("PDF processing is only available in the browser environment.");
  }

  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import("pdfjs-dist/legacy/build/pdf");
  }

  const pdfjsLib = await pdfjsLibPromise;

  if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    try {
      const workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
    } catch (error) {
      console.warn("Failed to set pdf.js worker source", error);
    }
  }

  return pdfjsLib;
}

export async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to read file"));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function inferImageMimeType(fileName: string) {
  const extension = fileName.split(".").pop()?.toLowerCase();

  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    default:
      return "";
  }
}

function isImageFile(file: File) {
  return file.type.startsWith("image/") || Boolean(inferImageMimeType(file.name));
}

async function imageFileToImagePage(file: File): Promise<string> {
  const imageFile = file.type.startsWith("image/")
    ? file
    : new File([file], file.name, { type: inferImageMimeType(file.name) || "image/jpeg" });
  const dataUrl = await fileToDataUrl(imageFile);

  return new Promise((resolve) => {
    const image = new Image();

    image.onload = () => {
      const maxSide = 1800;
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      if (!context) {
        resolve(dataUrl);
        return;
      }

      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.9));
    };

    image.onerror = () => resolve(dataUrl);
    image.src = dataUrl;
  });
}

export async function fileToImagePages(file: File): Promise<string[]> {
  if (isImageFile(file)) {
    return [await imageFileToImagePage(file)];
  }

  try {
    const pdfjsLib = await loadPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const images: string[] = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("Unable to create canvas context");
      }

      canvas.width = viewport.width;
      canvas.height = viewport.height;

      await page.render({ canvasContext: context, viewport }).promise;
      images.push(canvas.toDataURL("image/jpeg", 0.9));
    }

    return images;
  } catch (error) {
    console.warn("Falling back to simple data URL conversion", error);
    const fallback = await fileToDataUrl(file);
    return [fallback];
  }
}

export const pdfToImagePages = fileToImagePages;

export function base64ToInlineData(base64: string, mimeType: string) {
  return {
    inlineData: {
      data: base64.split(",")[1],
      mimeType,
    },
  };
}
