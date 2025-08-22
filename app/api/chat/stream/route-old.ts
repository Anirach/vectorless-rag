import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { question, documents } = body;

    if (!question || !documents || !Array.isArray(documents)) {
      return NextResponse.json(
        { error: 'Missing required fields: question and documents' },
        { status: 400 }
      );
    }

    // Step 1: Document Selection
    const selectedDocuments = await selectRelevantDocuments(question, documents);
    
    // Step 2: Page Relevance Detection
    const relevantPages = await findRelevantPages(question, selectedDocuments);
    
    // Step 3: Generate Answer
    const answer = await generateAnswer(question, relevantPages);
    
    return NextResponse.json({
      answer,
      sources: relevantPages.map(page => ({
        document: page.document,
        page_number: page.page_number,
        relevance_score: page.relevance_score
      }))
    });

  } catch (error) {
    console.error('Chat stream error:', error);
    return NextResponse.json(
      { 
        error: 'Sorry, I encountered an error while processing your question. Please try again.',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}

async function selectRelevantDocuments(question: string, documents: any[]) {
  if (documents.length <= 3) {
    return documents; // If we have 3 or fewer documents, use them all
  }

  try {
    const documentSummaries = documents.map(doc => ({
      id: doc.id,
      filename: doc.filename,
      summary: `Document: ${doc.filename} (${doc.pages?.length || 0} pages)`
    }));

    const prompt = `Given this question: "${question}"

And these documents:
${documentSummaries.map(doc => `- ${doc.filename}`).join('\n')}

Which documents are most likely to contain relevant information to answer the question? 
Return only the document filenames that are relevant, one per line. If all documents could be relevant, return all of them.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    });

    const selectedFilenames = response.choices[0]?.message?.content
      ?.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0) || [];

    // Filter documents based on LLM selection
    const selected = documents.filter(doc => 
      selectedFilenames.some(filename => 
        doc.filename.toLowerCase().includes(filename.toLowerCase()) ||
        filename.toLowerCase().includes(doc.filename.toLowerCase())
      )
    );

    return selected.length > 0 ? selected : documents.slice(0, 3); // Fallback to first 3
  } catch (error) {
    console.error('Document selection error:', error);
    return documents.slice(0, 3); // Fallback to first 3 documents
  }
}

async function findRelevantPages(question: string, documents: any[]) {
  const relevantPages = [];

  for (const doc of documents) {
    if (!doc.pages || !Array.isArray(doc.pages)) continue;

    for (const page of doc.pages) {
      try {
        const prompt = `Question: "${question}"

Page content:
${page.content}

Is this page content relevant to answering the question? Respond with just "YES" or "NO" and a relevance score from 0-10.
Format: YES 8 or NO 2`;

        const response = await openai.chat.completions.create({
          model: 'gpt-4',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 10,
        });

        const result = response.choices[0]?.message?.content?.trim() || 'NO 0';
        const [relevance, scoreStr] = result.split(' ');
        const score = parseInt(scoreStr) || 0;

        if (relevance === 'YES' && score >= 5) {
          relevantPages.push({
            document: doc.filename,
            page_number: page.page_number,
            content: page.content,
            relevance_score: score
          });
        }
      } catch (error) {
        console.error('Page relevance detection error:', error);
        // If LLM fails, include the page anyway
        relevantPages.push({
          document: doc.filename,
          page_number: page.page_number,
          content: page.content,
          relevance_score: 5
        });
      }
    }
  }

  // Sort by relevance score and take top pages
  return relevantPages
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, 10); // Limit to top 10 pages
}

async function generateAnswer(question: string, relevantPages: any[]) {
  if (relevantPages.length === 0) {
    return "I couldn't find any relevant information in the uploaded documents to answer your question. Please try rephrasing your question or check if the relevant information is contained in the documents.";
  }

  const context = relevantPages.map(page => 
    `From ${page.document} (page ${page.page_number}):\n${page.content}`
  ).join('\n\n---\n\n');

  const prompt = `Based on the following document excerpts, please answer the question. If the information is not sufficient or not found in the documents, please say so clearly.

Question: ${question}

Document excerpts:
${context}

Please provide a comprehensive answer based only on the information provided in the documents. Include specific references to the source documents and page numbers when possible.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1000,
    });

    return response.choices[0]?.message?.content || 
      "I apologize, but I couldn't generate a proper response. Please try again.";
  } catch (error) {
    console.error('Answer generation error:', error);
    return "I encountered an error while generating the answer. Please try again.";
  }
}
