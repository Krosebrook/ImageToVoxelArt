
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

/**
 * Extracts a complete HTML document from a string.
 */
export const extractHtmlFromText = (text: string): string => {
  if (!text) return "";
  const htmlMatch = text.match(/(<!DOCTYPE html>|<html)[\s\S]*?<\/html>/i);
  if (htmlMatch) return htmlMatch[0];
  const codeBlockMatch = text.match(/```(?:html)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  return text.trim();
};

/**
 * Injects CSS to hide UI overlays and standardize the viewport.
 */
export const hideBodyText = (html: string): string => {
  const cssToInject = `
    <style>
      #info, #loading, #ui, #instructions, .label, .overlay, #description, .dg.ac {
        display: none !important;
        opacity: 0 !important;
        pointer-events: none !important;
        visibility: hidden !important;
        z-index: -9999 !important;
      }
      body {
        user-select: none !important;
        margin: 0;
        overflow: hidden;
        background-color: transparent;
      }
      canvas {
        display: block;
        width: 100vw !important;
        height: 100vh !important;
      }
    </style>
  `;
  return injectIntoHead(html, cssToInject);
};

/**
 * Injects the Exporter Bridge into the iframe.
 * Handles EXPORT_SCENE (OBJ/VOX) and GET_SNAPSHOT (Gallery previews).
 */
export const injectExporterBridge = (html: string): string => {
  const bridgeScript = `
    <script>
      window.addEventListener('message', async (event) => {
        if (!event.data) return;

        // Snapshot Utility for Gallery Previews
        if (event.data.type === 'GET_SNAPSHOT') {
          if (typeof renderer !== 'undefined') {
            // Force a render to ensure the buffer is current
            if (typeof scene !== 'undefined' && typeof camera !== 'undefined') {
              renderer.render(scene, camera);
            }
            const dataUrl = renderer.domElement.toDataURL('image/webp', 0.8);
            window.parent.postMessage({ type: 'SNAPSHOT_RESULT', dataUrl }, '*');
          }
          return;
        }

        if (event.data.type === 'EXPORT_SCENE') {
          const format = event.data.format;
          const voxels = [];
          
          if (typeof scene !== 'undefined') {
            scene.traverse((object) => {
              if (object.isInstancedMesh) {
                const matrix = new THREE.Matrix4();
                const color = new THREE.Color();
                for (let i = 0; i < object.count; i++) {
                  object.getMatrixAt(i, matrix);
                  const pos = new THREE.Vector3().setFromMatrixPosition(matrix);
                  object.getColorAt(i, color);
                  voxels.push({
                    x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z),
                    r: Math.floor(color.r * 255), g: Math.floor(color.g * 255), b: Math.floor(color.b * 255)
                  });
                }
              } else if (object.isMesh && object.geometry.type === 'BoxGeometry') {
                const pos = object.position;
                const color = object.material.color || {r:1, g:1, b:1};
                voxels.push({
                  x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z),
                  r: Math.floor(color.r * 255), g: Math.floor(color.g * 255), b: Math.floor(color.b * 255)
                });
              }
            });
          }

          if (format === 'OBJ') {
            let objContent = "# Voxel Forge Export\n";
            voxels.forEach((v, i) => {
              const offset = i * 8;
              const s = 0.5;
              objContent += \`v \${v.x-s} \${v.y-s} \${v.z+s}\nv \${v.x+s} \${v.y-s} \${v.z+s}\nv \${v.x+s} \${v.y+s} \${v.z+s}\nv \${v.x-s} \${v.y+s} \${v.z+s}\nv \${v.x-s} \${v.y-s} \${v.z-s}\nv \${v.x+s} \${v.y-s} \${v.z-s}\nv \${v.x+s} \${v.y+s} \${v.z-s}\nv \${v.x-s} \${v.y+s} \${v.z-s}\n\`;
              objContent += \`f \${offset+1} \${offset+2} \${offset+3} \${offset+4}\nf \${offset+8} \${offset+7} \${offset+6} \${offset+5}\nf \${offset+1} \${offset+4} \${offset+8} \${offset+5}\nf \${offset+2} \${offset+1} \${offset+5} \${offset+6}\nf \${offset+3} \${offset+2} \${offset+6} \${offset+7}\nf \${offset+4} \${offset+3} \${offset+7} \${offset+8}\n\`;
            });
            window.parent.postMessage({ type: 'EXPORT_RESULT', format: 'OBJ', content: objContent }, '*');
          } else if (format === 'VOX') {
            window.parent.postMessage({ type: 'EXPORT_RESULT', format: 'VOX', content: JSON.stringify(voxels) }, '*');
          }
        }
      });
    </script>
  `;
  return injectIntoHead(html, bridgeScript);
};

/**
 * Injects a polished entrance animation.
 */
export const injectSubtleAnimation = (html: string): string => {
  const animationToInject = `
    <style>
      @keyframes voxelEntrance {
        0% { opacity: 0; transform: scale(0.98) translateY(10px); }
        100% { opacity: 1; transform: scale(1) translateY(0); }
      }
      canvas {
        animation: voxelEntrance 1.2s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
      }
    </style>
  `;
  return injectIntoHead(html, animationToInject);
};

/**
 * Updates camera position and target. 
 */
export const setCameraView = (html: string, position: {x: number, y: number, z: number}): string => {
  const setRegex = /camera\.position\.set\(\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*\)/g;
  let updated = html.replace(setRegex, `camera.position.set(${position.x}, ${position.y}, ${position.z})`);
  updated = updated.replace(/camera\.position\.x\s*=\s*(-?\d*\.?\d+)/g, `camera.position.x = ${position.x}`);
  updated = updated.replace(/camera\.position\.y\s*=\s*(-?\d*\.?\d+)/g, `camera.position.y = ${position.y}`);
  updated = updated.replace(/camera\.position\.z\s*=\s*(-?\d*\.?\d+)/g, `camera.position.z = ${position.z}`);
  if (!updated.includes('camera.lookAt(0, 0, 0)')) {
     updated = updated.replace(/renderer\.render/g, `camera.lookAt(0, 0, 0); renderer.render`);
  }
  return updated;
};

/**
 * Advanced scene parameter updates: Background, Rotation, Atmosphere.
 */
export const updateSceneParameters = (
  html: string, 
  params: { 
    backgroundColor: string, 
    autoRotate: boolean,
    lightIntensity: number,
    fogDensity: number
  }
): string => {
  const { backgroundColor, autoRotate, lightIntensity, fogDensity } = params;
  const bgRegex = /scene\.background\s*=\s*new\s*THREE\.Color\s*\([^)]+\)/gi;
  let updated = html.replace(bgRegex, `scene.background = new THREE.Color('${backgroundColor}')`);
  const rotateRegex = /controls\.autoRotate\s*=\s*(true|false)/gi;
  if (rotateRegex.test(updated)) {
    updated = updated.replace(rotateRegex, `controls.autoRotate = ${autoRotate}`);
  } else {
    updated = updated.replace(/controls\.update\(\)/g, `controls.autoRotate = ${autoRotate}; controls.update()`);
  }
  const intensityRegex = /(AmbientLight|DirectionalLight|PointLight|SpotLight)\s*\(\s*([^,]+)\s*,\s*(-?\d*\.?\d+)\s*\)/gi;
  updated = updated.replace(intensityRegex, (match, type, color, currentIntensity) => `${type}(${color}, ${lightIntensity})`);
  const fogRegex = /new\s*THREE\.(Fog|FogExp2)\s*\(\s*([^,]+)\s*,\s*(-?\d*\.?\d+)([^)]*)\)/gi;
  updated = updated.replace(fogRegex, (match, type, color, currentDensity, rest) => {
      if (type === 'FogExp2') return `new THREE.FogExp2(${color}, ${fogDensity / 50})`;
      return `new THREE.Fog(${color}, 10, ${100 / (fogDensity || 0.1)})`;
  });
  const styleToInject = `<style>body { background-color: ${backgroundColor} !important; }</style>`;
  return injectIntoHead(updated, styleToInject);
};

const injectIntoHead = (html: string, content: string): string => {
  if (html.toLowerCase().includes('</head>')) {
    return html.replace(/<\/head>/i, `${content}</head>`);
  }
  return content + html;
};
