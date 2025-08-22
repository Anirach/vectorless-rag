import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { question, documents, description, model = 'gpt-4', chat_history } = body;

    // Debug logging
    console.log('=== Chat Stream Debug Info ===');
    console.log('Question:', question);
    console.log('Documents received:', documents?.length || 0);
    console.log('Documents is array:', Array.isArray(documents));
    console.log('Documents type:', typeof documents);
    console.log('Documents structure:', JSON.stringify(documents?.slice(0, 1), null, 2)); // Log first document for debugging
    console.log('Description:', description);
    console.log('Raw body keys:', Object.keys(body));
    console.log('===============================');

    if (!question || !documents || !Array.isArray(documents)) {
      return NextResponse.json(
        { error: 'Missing required fields: question and documents' },
        { status: 400 }
      );
    }

    // Create a readable stream for Server-Sent Events
    const encoder = new TextEncoder();
    
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Helper function to send SSE message
          const sendMessage = (data: any) => {
            const message = `data: ${JSON.stringify(data)}\n\n`;
            controller.enqueue(encoder.encode(message));
          };

          // Step 1: Document Selection
          sendMessage({
            type: 'status',
            message: 'Analyzing your document collection and selecting relevant documents...',
            step_number: 1,
            total_steps: 3
          });

          const stepStartTime = Date.now();
          const selectedDocuments = await selectRelevantDocuments(question, documents, description);
          const step1Time = (Date.now() - stepStartTime) / 1000;
          
          sendMessage({
            type: 'step_complete',
            step_number: 1,
            step_time: step1Time,
            step_cost: 0.001, // Approximate cost
            selected_documents: selectedDocuments.map(doc => doc.filename)
          });

          // Step 2: Page Relevance Detection
          sendMessage({
            type: 'status',
            message: 'Examining page content to find the most relevant information...',
            step_number: 2,
            total_steps: 3
          });

          const step2StartTime = Date.now();
          const relevantPages = await findRelevantPages(question, selectedDocuments);
          const step2Time = (Date.now() - step2StartTime) / 1000;
          
          sendMessage({
            type: 'step_complete',
            step_number: 2,
            step_time: step2Time,
            step_cost: 0.002,
            relevant_pages_count: relevantPages.length
          });

          // Step 3: Generate Answer
          sendMessage({
            type: 'status',
            message: 'Generating your answer based on the relevant content...',
            step_number: 3,
            total_steps: 3
          });

          const step3StartTime = Date.now();
          const answer = await generateAnswer(question, relevantPages, chat_history);
          const step3Time = (Date.now() - step3StartTime) / 1000;
          
          sendMessage({
            type: 'step_complete',
            step_number: 3,
            step_time: step3Time,
            step_cost: 0.005
          });

          // Send the final answer
          sendMessage({
            type: 'content',
            content: answer
          });

          // Send completion message
          sendMessage({
            type: 'done',
            metadata: {
              selectedDocuments: selectedDocuments.map(doc => ({
                filename: doc.filename,
                pages: doc.pages?.length || 0
              })),
              relevantPagesCount: relevantPages.length,
              totalCost: 0.008,
              totalTime: step1Time + step2Time + step3Time
            }
          });

          controller.close();
          
        } catch (error) {
          console.error('Chat stream error:', error);
          const errorMessage = {
            type: 'error',
            error: 'Sorry, I encountered an error while processing your question. Please try again.',
            details: error instanceof Error ? error.message : 'Unknown error'
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorMessage)}\n\n`));
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });

  } catch (error) {
    console.error('Chat stream initialization error:', error);
    return NextResponse.json(
      { 
        error: 'Sorry, I encountered an error while processing your question. Please try again.',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

async function selectRelevantDocuments(question: string, documents: any[], description: string = '') {
  console.log('=== Document Selection Debug ===');
  console.log('Total documents:', documents.length);
  console.log('Sample document keys:', documents.length > 0 ? Object.keys(documents[0]) : 'No documents');
  
  try {
    // Use OpenAI to determine which documents are most relevant to the question
    const documentSummaries = documents.map(doc => 
      `Document: ${doc.filename} (${doc.total_pages || doc.pages?.length || 0} pages)`
    ).join('\n');

    console.log('Document summaries:', documentSummaries);

    const prompt = `Given the following question and list of documents, select the most relevant documents (up to 5) that would help answer the question.

Question: ${question}
${description ? `Context: ${description}` : ''}

Available documents:
${documentSummaries}

Return the document filenames that are most relevant, one per line. If all documents could be relevant, return all of them.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'You are a document analysis assistant. Select the most relevant documents based on the question asked.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 200,
      temperature: 0.3,
    });

    const selectedFilenames = completion.choices[0]?.message?.content
      ?.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0) || [];

    console.log('AI selected filenames:', selectedFilenames);

    // Filter documents based on AI selection
    const selectedDocs = documents.filter(doc => 
      selectedFilenames.some(filename => 
        doc.filename.toLowerCase().includes(filename.toLowerCase()) ||
        filename.toLowerCase().includes(doc.filename.toLowerCase())
      )
    );

    console.log('Filtered selected docs:', selectedDocs.length);

    // If no matches found or AI response was unclear, return first 3 documents as fallback
    const result = selectedDocs.length > 0 ? selectedDocs.slice(0, 5) : documents.slice(0, 3);
    console.log('Final selected documents:', result.length);
    console.log('=================================');
    
    return result;
    
  } catch (error) {
    console.error('Error in document selection:', error);
    // Fallback to first few documents if AI selection fails
    return documents.slice(0, Math.min(3, documents.length));
  }
}

async function findRelevantPages(question: string, selectedDocuments: any[]) {
  console.log('=== Page Analysis Debug ===');
  console.log('Documents to analyze:', selectedDocuments.length);
  
  selectedDocuments.forEach((doc, index) => {
    console.log(`Document ${index + 1}: ${doc.filename}`);
    console.log(`  Pages: ${doc.pages?.length || 0}`);
    if (doc.pages?.length > 0) {
      console.log(`  First page content preview: ${doc.pages[0].content?.substring(0, 100) || doc.pages[0].text?.substring(0, 100) || 'No content'}...`);
    }
  });
  
  try {
    const relevantPages: Array<{
      document: string;
      page_number: number;
      content: string;
      relevance_score: number;
    }> = [];
    
    for (const doc of selectedDocuments) {
      if (doc.pages && Array.isArray(doc.pages)) {
        // Process pages in batches to avoid overwhelming the API
        const pageChunks = [];
        const PAGES_PER_BATCH = 5;
        
        for (let i = 0; i < doc.pages.length; i += PAGES_PER_BATCH) {
          const batch = doc.pages.slice(i, i + PAGES_PER_BATCH);
          pageChunks.push(batch);
        }
        
        for (const batch of pageChunks) {
          const pageTexts = batch.map((page: any) => 
            `Page ${page.page_number}: ${page.text || page.content || ''}`
          ).join('\n\n---\n\n');

          const prompt = `Analyze the following pages from document "${doc.filename}" and determine which pages are relevant to answering this question: "${question}"

Pages content:
${pageTexts}

For each relevant page, provide:
1. Page number
2. Relevance score (0.0 to 1.0)
3. Brief reason why it's relevant

Format as: "Page X: Score Y - Reason"
Only include pages with relevance score above 0.3.`;

          try {
            const completion = await openai.chat.completions.create({
              model: 'gpt-3.5-turbo',
              messages: [
                {
                  role: 'system',
                  content: 'You are a content analysis assistant. Analyze document pages for relevance to specific questions.'
                },
                {
                  role: 'user',
                  content: prompt
                }
              ],
              max_tokens: 300,
              temperature: 0.3,
            });

            const response = completion.choices[0]?.message?.content || '';
            const lines = response.split('\n').filter(line => line.trim().length > 0);
            
            for (const line of lines) {
              const match = line.match(/Page (\d+):\s*Score\s*([\d.]+)/i);
              if (match) {
                const pageNum = parseInt(match[1]);
                const score = parseFloat(match[2]);
                
                const page = batch.find((p: any) => p.page_number === pageNum);
                if (page && score > 0.3) {
                  relevantPages.push({
                    document: doc.filename,
                    page_number: page.page_number,
                    content: page.text || page.content || '',
                    relevance_score: score
                  });
                }
              }
            }
          } catch (batchError) {
            console.error(`Error analyzing batch for ${doc.filename}:`, batchError);
            // Fallback: include all pages from this batch with lower score
            batch.forEach((page: any) => {
              relevantPages.push({
                document: doc.filename,
                page_number: page.page_number,
                content: page.text || page.content || '',
                relevance_score: 0.5
              });
            });
          }
        }
      }
    }
    
    // Sort by relevance score and return top pages
    relevantPages.sort((a, b) => b.relevance_score - a.relevance_score);
    return relevantPages.slice(0, 10); // Return top 10 most relevant pages
    
  } catch (error) {
    console.error('Error in page relevance detection:', error);
    
    // Fallback: return all pages from selected documents
    const fallbackPages: Array<{
      document: string;
      page_number: number;
      content: string;
      relevance_score: number;
    }> = [];
    
    for (const doc of selectedDocuments) {
      if (doc.pages && Array.isArray(doc.pages)) {
        doc.pages.forEach((page: any) => {
          fallbackPages.push({
            document: doc.filename,
            page_number: page.page_number,
            content: page.text || page.content || '',
            relevance_score: 0.5
          });
        });
      }
    }
    return fallbackPages.slice(0, 10);
  }
}

async function generateAnswer(question: string, relevantPages: any[], chatHistory: any[] = []) {
  try {
    // Prepare context from relevant pages
    const context = relevantPages.map(page => 
      `Document: ${page.document}, Page ${page.page_number}:\n${page.content}`
    ).join('\n\n');

    // Prepare chat history for context
    const historyContext = chatHistory.length > 0 
      ? chatHistory.map((msg: any) => `${msg.role}: ${msg.content}`).join('\n')
      : '';

    const prompt = `You are a helpful assistant that answers questions based on the provided document context.

${historyContext ? `Previous conversation:\n${historyContext}\n\n` : ''}

Context from documents:
${context}

Question: ${question}

Please provide a comprehensive answer based on the document context. If the information isn't available in the documents, say so clearly. Include specific references to the documents and page numbers when possible.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that answers questions based on provided document context. Always cite your sources when possible.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 1000,
      temperature: 0.7,
    });

    return completion.choices[0]?.message?.content || 'I apologize, but I was unable to generate a response. Please try again.';
    
  } catch (error) {
    console.error('OpenAI API error:', error);
    
    // Fallback response if OpenAI fails
    return `Based on the documents you've uploaded, I can see content related to your question about "${question}". However, I encountered an issue accessing the AI service to provide a detailed analysis. 

The documents contain relevant information across ${relevantPages.length} pages from ${new Set(relevantPages.map(p => p.document)).size} document(s). Please try asking your question again, or check that your OpenAI API key is properly configured.

Error details: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}
