
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { GoogleGenAI } from "@google/genai";
import { extractHtmlFromText } from "../utils/html";

/**
 * Initialize the Google Generative AI client.
 * API Key is strictly sourced from process.env.API_KEY per security protocols.
 */
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

/**
 * System instruction for the Image Generation model (gemini-2.5-flash-image).
 * Focuses on generating subjects that translate well to 3D voxel grids.
 */
export const IMAGE_SYSTEM_PROMPT = `
Generate a single, high-fidelity object or focused scene centered on a clean, contrasting background. 
Prioritize strong geometric forms, clear silhouettes, and vibrant, distinct lighting. 
Avoid messy or overly complex backgrounds that hinder 3D isolation.
`;

/**
 * System instruction for the Voxel Generation model (gemini-3-pro-preview).
 * Guides the model to output high-performance Three.js code using modern patterns.
 */
export const VOXEL_PROMPT_INSTRUCTION = `
You are a world-class Three.js engineer specializing in Voxel Art.
Task: Create a sophisticated, performant 3D voxel scene based on the provided image.

Technical Requirements:
1. USE InstancedMesh for all voxels to ensure 60fps performance even with high block counts.
2. VOXEL SIZE: Use the provided base unit size for the BoxGeometry dimensions and grid spacing.
3. COLOR PALETTE: If a specific palette is provided, adhere to it strictly. Otherwise, sample colors accurately from the image.
4. SCENE STRUCTURE: Create a clear subject (island, building, character) and a ground/atmosphere.
5. ANIMATION: Include subtle movement (floating, rotating, or environmental effects).
6. ACCESSIBILITY: Define clear variable names (e.g., scene, camera, renderer, controls) so external hooks can access them.
7. OUTPUT: Return only the complete, self-contained HTML/JavaScript file.
`;

/**
 * Generates an inspiration image based on a text prompt.
 * @param prompt - The user's creative description.
 * @param aspectRatio - The desired dimensions (1:1, 16:9, etc.)
 * @param optimize - Whether to apply the system prompt for better 3D translation.
 * @returns Base64-encoded image string.
 */
export const generateImage = async (
  prompt: string, 
  aspectRatio: string = '1:1', 
  optimize: boolean = true
): Promise<string> => {
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

    const part = response.candidates?.[0]?.content?.parts.find(p => p.inlineData);
    if (part?.inlineData) {
      return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
    }
    
    throw new Error("Gemini Image API failed to return binary data.");
  } catch (error) {
    console.error("Critical: Image Generation Engine Failure", error);
    throw error;
  }
};

/**
 * Transmutes a 2D image into a 3D Voxel Scene (Three.js HTML).
 * @param imageBase64 - Source image in base64.
 * @param onThoughtUpdate - Callback for streaming the model's reasoning/process.
 * @param palette - Optional hex code array to enforce a specific look.
 * @param voxelSize - The numeric base size for voxels (e.g., 0.5, 1, 2).
 * @returns A string containing self-contained Three.js HTML.
 */
export const generateVoxelScene = async (
  imageBase64: string, 
  onThoughtUpdate?: (thought: string) => void,
  palette?: string[],
  voxelSize: number = 1
): Promise<string> => {
  const base64Data = imageBase64.split(',')[1] || imageBase64;
  const mimeMatch = imageBase64.match(/^data:(.*?);base64,/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';

  let accumulatedResponse = "";
  let promptText = `Translate this image into a detailed 3D voxel scene using a base voxel size of ${voxelSize} units.`;
  
  if (palette && palette.length > 0) {
    promptText += `\n\nREQUIRED PALETTE: ${palette.join(', ')}. Use these hex values for primary structures.`;
  }

  try {
    const responseStream = await ai.models.generateContentStream({
      model: 'gemini-3-pro-preview',
      contents: {
        parts: [
          { inlineData: { mimeType, data: base64Data } },
          { text: promptText }
        ]
      },
      config: {
        systemInstruction: VOXEL_PROMPT_INSTRUCTION,
        thinkingConfig: { thinkingBudget: 32768 },
      },
    });

    for await (const chunk of responseStream) {
      const candidates = chunk.candidates;
      if (candidates?.[0]?.content?.parts) {
        for (const part of candidates[0].content.parts) {
          const p = part as any;
          if (p.thought && onThoughtUpdate) {
             onThoughtUpdate(p.thought);
          }
          if (p.text) {
            accumulatedResponse += p.text;
          }
        }
      }
    }

    const cleanedHtml = extractHtmlFromText(accumulatedResponse);
    if (!cleanedHtml) throw new Error("Generated content did not contain valid HTML/JS.");
    
    return cleanedHtml;
  } catch (error) {
    console.error("Critical: Voxel Transmutation Engine Failure", error);
    throw error;
  }
};
