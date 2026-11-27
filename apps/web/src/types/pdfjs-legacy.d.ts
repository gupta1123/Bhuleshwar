declare module "pdfjs-dist/legacy/build/pdf" {
  export const GlobalWorkerOptions: {
    workerSrc: string;
  };

  type PdfViewport = {
    width: number;
    height: number;
    transform: number[];
  };

  type PdfTextItem = {
    str?: string;
    transform: number[];
    width: number;
    height: number;
  };

  type PdfPage = {
    rotate: number;
    getViewport(params: { scale: number; rotation?: number }): PdfViewport;
    getTextContent(): Promise<{ items: PdfTextItem[] }>;
    render(params: {
      canvasContext: CanvasRenderingContext2D;
      viewport: PdfViewport;
    }): {
      promise: Promise<void>;
      cancel(): void;
    };
  };

  type PdfDocument = {
    numPages: number;
    getPage(pageNumber: number): Promise<PdfPage>;
    destroy(): Promise<void>;
  };

  export const Util: {
    transform(m1: number[], m2: number[]): number[];
  };

  export function getDocument(source: { data: ArrayBuffer | Uint8Array; isEvalSupported?: boolean }): {
    promise: Promise<PdfDocument>;
    destroy(): Promise<void>;
  };
}
