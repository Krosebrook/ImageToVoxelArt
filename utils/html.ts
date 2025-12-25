
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/


/**
 * Extracts a complete HTML document from a string that might contain
 * conversational text, markdown code blocks, etc.
 */
export const extractHtmlFromText = (text: string): string => {
  if (!text) return "";

  // 1. Try to find a complete HTML document structure (most reliable)
  // Matches <!DOCTYPE html>...</html> or <html>...</html>, case insensitive, spanning multiple lines
  const htmlMatch = text.match(/(<!DOCTYPE html>|<html)[\s\S]*?<\/html>/i);
  if (htmlMatch) {
    return htmlMatch[0];
  }

  // 2. Fallback: Try to extract content from markdown code blocks if specific HTML tags weren't found
  const codeBlockMatch = text.match(/```(?:html)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // 3. Return raw text if no structure is found (trim whitespace)
  return text.trim();
};

/**
 * Injects CSS into the HTML to hide common text elements (like loading screens,
 * info overlays, instructions)
 */
export const hideBodyText = (html: string): string => {
  const cssToInject = `
    <style>
      /* Hides common overlay IDs and classes used in Three.js examples and generated code */
      #info, #loading, #ui, #instructions, .label, .overlay, #description {
        display: none !important;
        opacity: 0 !important;
        pointer-events: none !important;
        visibility: hidden !important;
        z-index: -1000 !important;
      }
      /* Ensure the body doesn't show selected text cursor interaction outside canvas */
      body {
        user-select: none !important;
        margin: 0;
        overflow: hidden;
      }
    </style>
  `;

  // Inject before closing head if possible, otherwise before closing body, or append
  if (html.toLowerCase().includes('</head>')) {
    return html.replace(/<\/head>/i, `${cssToInject}</head>`);
  }
  if (html.toLowerCase().includes('</body>')) {
    return html.replace(/<\/body>/i, `${cssToInject}</body>`);
  }
  return html + cssToInject;
};

/**
 * Injects a subtle float and fade-in animation to the voxel scene.
 */
export const injectSubtleAnimation = (html: string): string => {
  const animationToInject = `
    <style>
      @keyframes voxelEntrance {
        0% { opacity: 0; transform: scale(0.98) translateY(10px); }
        100% { opacity: 1; transform: scale(1) translateY(0); }
      }
      @keyframes voxelFloat {
        0% { transform: translateY(0px); }
        50% { transform: translateY(-8px); }
        100% { transform: translateY(0px); }
      }
      canvas {
        animation: voxelEntrance 1.5s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
      }
      /* Apply a very gentle global float to the body content for ambient life */
      body {
        animation: voxelFloat 6s ease-in-out infinite;
      }
    </style>
  `;

  if (html.toLowerCase().includes('</head>')) {
    return html.replace(/<\/head>/i, `${animationToInject}</head>`);
  }
  return html + animationToInject;
};

/**
 * Adjusts the camera position to zoom the camera in by 20% (multiplying coordinates by 0.8).
 * This brings the camera closer to the center (0,0,0).
 */
export const zoomCamera = (html: string, zoomFactor: number = 0.8): string => {
  // 1. Replace camera.position.set(x, y, z)
  const setRegex = /camera\.position\.set\(\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*\)/g;
  let updated = html.replace(setRegex, (match, x, y, z) => {
    const newX = parseFloat(x) * zoomFactor;
    const newY = parseFloat(y) * zoomFactor;
    const newZ = parseFloat(z) * zoomFactor;
    return `camera.position.set(${newX}, ${newY}, ${newZ})`;
  });

  // 2. Replace individual camera.position.x/y/z assignments for robustness
  updated = updated.replace(/camera\.position\.x\s*=\s*(-?\d*\.?\d+)/g, (match, val) => {
    return `camera.position.x = ${parseFloat(val) * zoomFactor}`;
  });
  updated = updated.replace(/camera\.position\.y\s*=\s*(-?\d*\.?\d+)/g, (match, val) => {
    return `camera.position.y = ${parseFloat(val) * zoomFactor}`;
  });
  updated = updated.replace(/camera\.position\.z\s*=\s*(-?\d*\.?\d+)/g, (match, val) => {
    return `camera.position.z = ${parseFloat(val) * zoomFactor}`;
  });

  return updated;
};

/**
 * Overrides the scene and body background color.
 */
export const applySceneBackground = (html: string, color: string): string => {
  // 1. Replace scene.background assignments
  const bgRegex = /scene\.background\s*=\s*new\s*THREE\.Color\s*\([^)]+\)/gi;
  let updated = html.replace(bgRegex, `scene.background = new THREE.Color('${color}')`);

  // 2. Inject CSS for body and renderer clear color fallback
  const styleToInject = `
    <style>
      body { background-color: ${color} !important; }
    </style>
  `;

  if (updated.toLowerCase().includes('</head>')) {
    updated = updated.replace(/<\/head>/i, `${styleToInject}</head>`);
  } else {
    updated = updated + styleToInject;
  }

  return updated;
};
