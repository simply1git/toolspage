const { convertPdfToDocx } = require("../server/services");
const fs = require("fs");
const path = require("path");

async function testPdfToWord() {
  console.log("Testing PDF to Word conversion...");
  
  // Create a minimal valid PDF (PDF-1.4)
  const pdfContent = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>\nendobj\n" +
    "4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 12 Tf 100 700 Td (Hello World) Tj ET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000056 00000 n \n0000000111 00000 n \n0000000212 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n307\n%%EOF"
  );

  const file = {
    buffer: pdfContent,
    originalname: "test.pdf",
    mimetype: "application/pdf"
  };

  const options = {
    language: "english",
    ocrMode: "off"
  };

  const config = {
    enableClamScan: false
  };

  try {
    const result = await convertPdfToDocx(file, options, config);
    console.log("Success! Output filename:", result.outputName);
    console.log("Output buffer length:", result.buffer.length);
    
    if (result.buffer.length > 0 && result.outputName.endsWith(".docx")) {
      console.log("Functional probe PASSED");
    } else {
      console.log("Functional probe FAILED: Invalid output");
    }
  } catch (error) {
    console.error("Functional probe FAILED with error:", error.message);
  }
}

testPdfToWord();
