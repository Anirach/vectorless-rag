import { NextRequest, NextResponse } from 'next/server';

interface PageData {
  page_number: number;
  text: string;
}

export async function GET() {
  return NextResponse.json({
    message: "Upload endpoint",
    method: "POST", 
    description: "Upload PDF files with automatic chunking for large uploads",
    limits: {
      max_payload_size_mb: 4.5,
      max_files_total: 100,
      max_file_size_mb: 20,
      supported_formats: ["PDF"],
    },
    recommendations: [
      "For uploads over 4.5MB, use chunked upload automatically",
      "Individual PDFs can be up to 20MB each",
      "Up to 100 files total supported",
    ],
  });
}

export async function POST(request: NextRequest) {
  try {
    // Get the content type to determine if this is a chunked upload
    const contentType = request.headers.get('content-type') || '';
    
    // Check for chunked upload headers
    const chunkIndex = request.headers.get('X-Chunk-Index');
    const totalChunks = request.headers.get('X-Total-Chunks');
    const chunkId = request.headers.get('X-Chunk-Id');
    
    if (chunkIndex !== null && totalChunks !== null && chunkId !== null) {
      return handleChunkedUpload(request, parseInt(chunkIndex), parseInt(totalChunks), chunkId);
    } else {
      return handleRegularUpload(request);
    }
    
  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json(
      {
        error: `Internal server error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        suggestion: "Please try again with fewer or smaller files",
      },
      { status: 500 }
    );
  }
}

async function handleRegularUpload(request: NextRequest) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];
    const description = formData.get('description') as string || '';
    
    if (!files || files.length === 0) {
      return NextResponse.json(
        { error: "No files provided" },
        { status: 400 }
      );
    }
    
    // Check file size limits
    const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json({
          error: `File too large: ${file.name}`,
          file_size_mb: Math.round(file.size / 1024 / 1024 * 10) / 10,
          max_size_mb: 20,
          suggestion: "Please reduce file size to under 20MB",
        }, { status: 413 });
      }
    }
    
    // Process files and extract text with proper page handling
    const documents = await Promise.all(files.map(async (file, index) => {
      const extractedData = await extractPDFWithPages(file);
      return {
        id: index + 1,
        filename: file.name,
        size: file.size,
        pages: extractedData.pages,
        total_pages: extractedData.pages.length
      };
    }));
    
    return NextResponse.json({
      message: "Files uploaded successfully",
      total_files: files.length,
      description: description,
      documents: documents,
    });
    
  } catch (error) {
    console.error('Regular upload error:', error);
    return NextResponse.json(
      {
        error: "Failed to process upload",
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

async function handleChunkedUpload(request: NextRequest, chunkIndex: number, totalChunks: number, chunkId: string) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];
    const description = formData.get('description') as string || '';
    
    // For now, return a simple chunked response
    // In a real implementation, you'd store chunks and combine them
    const documents = await Promise.all(files.map(async (file, index) => {
      const extractedData = await extractPDFWithPages(file);
      return {
        id: index + 1,
        filename: file.name,
        size: file.size,
        pages: extractedData.pages,
        total_pages: extractedData.pages.length
      };
    }));
    
    return NextResponse.json({
      message: `Chunk ${chunkIndex + 1}/${totalChunks} processed successfully`,
      chunk_info: {
        chunk_index: chunkIndex,
        total_chunks: totalChunks,
        chunk_id: chunkId,
        is_final_chunk: chunkIndex === totalChunks - 1
      },
      documents: documents,
      description: description,
    });
    
  } catch (error) {
    console.error('Chunked upload error:', error);
    return NextResponse.json(
      {
        error: "Failed to process chunked upload",
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

async function extractTextFromPDF(file: File): Promise<string> {
  try {
    // Dynamic import to avoid initialization issues
    const pdfParse = (await import('pdf-parse')).default;
    
    // Convert File to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // Parse PDF and extract text
    const data = await pdfParse(buffer);
    return data.text;
  } catch (error) {
    console.error(`Error extracting text from PDF ${file.name}:`, error);
    // Fallback to filename if extraction fails
    return `Error extracting content from ${file.name}. Please ensure the file is a valid PDF.`;
  }
}

async function extractPDFWithPages(file: File): Promise<{pages: PageData[]}> {
  try {
    // Dynamic import to avoid initialization issues
    const pdfParse = (await import('pdf-parse')).default;
    
    // Convert File to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // Parse PDF and extract text
    const data = await pdfParse(buffer);
    
    // For now, treat the entire text as a single page since pdf-parse doesn't split by pages
    // In a production environment, you might want to use pdf2pic + OCR or pdf-lib for page-by-page extraction
    const text = data.text;
    
    // Split text by common page break indicators or by character count
    const pages = splitTextIntoPages(text);
    
    return {
      pages: pages.map((pageText, index) => ({
        page_number: index + 1,
        text: pageText.trim()  // Use 'text' to match frontend interface
      }))
    };
  } catch (error) {
    console.error(`Error extracting PDF pages from ${file.name}:`, error);
    return {
      pages: [{
        page_number: 1,
        text: `Error extracting content from ${file.name}. Please ensure the file is a valid PDF.`
      }]
    };
  }
}

function splitTextIntoPages(text: string): string[] {
  // Split by common page break indicators
  let pages = text.split(/\f|\n\s*Page\s+\d+\s*\n|\n\s*\d+\s*\n\s*\n/i);
  
  // If no clear page breaks found, split by character count (approximate pages)
  if (pages.length === 1) {
    const CHARS_PER_PAGE = 2000; // Approximate characters per page
    pages = [];
    for (let i = 0; i < text.length; i += CHARS_PER_PAGE) {
      pages.push(text.substring(i, i + CHARS_PER_PAGE));
    }
  }
  
  // Filter out empty pages
  return pages.filter(page => page.trim().length > 0);
}
