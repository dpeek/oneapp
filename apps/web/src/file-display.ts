export const renderPdf = async (data: ArrayBuffer) => {
  const pdf = await import("pdfjs-dist");
  pdf.GlobalWorkerOptions.workerSrc = `/pdf.worker-${pdf.version}.mjs`;
  const loading = pdf.getDocument({
    data,
    enableXfa: false,
    useWasm: false,
    useSystemFonts: true,
    maxImageSize: 16_000_000,
  });
  try {
    const pdfDocument = await loading.promise;
    const page = await pdfDocument.getPage(1);
    const natural = page.getViewport({ scale: 1 });
    const scale = Math.min(1.5, 1100 / natural.width, 1500 / natural.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "PDF page 1");
    await page.render({
      canvas,
      viewport,
      annotationMode: pdf.AnnotationMode.DISABLE,
    }).promise;
    return canvas;
  } finally {
    await loading.destroy();
  }
};

const formats = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
export const fileSize = (size: number) =>
  size >= 1024 * 1024
    ? `${formats.format(size / (1024 * 1024))} MB`
    : size >= 1024
      ? `${formats.format(size / 1024)} KB`
      : `${size} B`;
