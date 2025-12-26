
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/


import { GoogleGenAI } from "@google/genai";
import { extractHtmlFromText } from "../utils/html";

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const IMAGE_SYSTEM_PROMPT = "Generate a high-quality, isolated object or scene on a clean, solid background. Vivid lighting, simple shapes.";
export const VOXEL_PROMPT = "I have provided an image. Code a sophisticated voxel art scene inspired by this using Three.js. Use InstancedMesh for performance. IMPORTANT: Use the provided colors strictly if available. Ensure a clear subject-ground relationship.";

export const generateImage = async (prompt: string, aspectRatio: string = '1:1', optimize: boolean = true): Promise<string> => {
  try {
    const finalPrompt = optimize ? `${IMAGE_SYSTEM_PROMPT}\n\nSubject: ${prompt}` : prompt;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: { parts: [{ text: finalPrompt }] },
      config: {
        imageConfig: {
          aspectRatio: aspectRatio as any,
        },
      },
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
      }
    }
    
    throw new Error("No image generated.");
  } catch (error) {
    console.error("Image generation failed:", error);
    throw error;
  }
};

export const generateVoxelScene = async (
  imageBase64: string, 
  onThoughtUpdate?: (thought: string) => void,
  palette?: string[]
): Promise<string> => {
  const base64Data = imageBase64.split(',')[1] || imageBase64;
  const mimeMatch = imageBase64.match(/^data:(.*?);base64,/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';

  let fullHtml = "";
  let customPrompt = VOXEL_PROMPT;
  if (palette && palette.length > 0) {
    customPrompt += `\n\nSTRICT COLOR PALETTE: ${palette.join(', ')}. Use these for the main subjects.`;
  }

  try {
    const response = await ai.models.generateContentStream({
      model: 'gemini-3-pro-preview',
      contents: {
        parts: [
          { inlineData: { mimeType, data: base64Data } },
          { text: customPrompt }
        ]
      },
      config: {
        thinkingConfig: { thinkingBudget: 32768 },
      },
    });

    for await (const chunk of response) {
      const candidates = chunk.candidates;
      if (candidates?.[0]?.content?.parts) {
        for (const part of candidates[0].content.parts) {
          const p = part as any;
          if (p.thought && onThoughtUpdate) {
             onThoughtUpdate(p.thought);
          }
          if (p.text) {
            fullHtml += p.text;
          }
        }
      }
    }

    return extractHtmlFromText(fullHtml);
  } catch (error) {
    console.error("Voxel forge failed:", error);
    throw error;
  }
};
