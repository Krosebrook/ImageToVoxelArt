
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { generateImage, generateVoxelScene } from './services/gemini';
import { 
  extractHtmlFromText, 
  hideBodyText, 
  setCameraView, 
  injectSubtleAnimation, 
  updateSceneParameters,
  injectExporterBridge,
  injectVoxelPhysics,
  injectInteractionBridge
} from './utils/html';

// --- Types ---
type AppStatus = 'idle' | 'generating_image' | 'generating_voxels' | 'error' | 'saving';
type VoxelStyle = 'Classic' | 'Micro' | 'Low Poly' | 'Cyberpunk';
type VoxelSizeLabel = 'Micro' | 'Classic' | 'Large';
type InspectorTab = 'transform' | 'atmosphere' | 'physics' | 'export';
type ExportFormat = 'OBJ' | 'VOX' | 'GLTF';
type ToolMode = 'view' | 'paint' | 'erase';

const VOXEL_SIZE_MAP: Record<VoxelSizeLabel, number> = {
  'Micro': 0.5,
  'Classic': 1.0,
  'Large': 2.0
};

interface SceneState {
  image: string;
  voxel: string | null;
  prompt: string;
  palette: string[];
  backgroundColor: string;
  autoRotate: boolean;
  lightIntensity: number;
  fogDensity: number;
  style: VoxelStyle;
  voxelSize: VoxelSizeLabel;
}

interface SavedScene extends SceneState {
  id: string;
  timestamp: number;
  thumbnail: string;
}

// --- Constants ---
const STORAGE_KEY = 'voxel_forge_v5_pro';
const ASPECT_RATIOS = ["1:1", "3:4", "4:3", "16:9", "9:16"];
const STYLES: VoxelStyle[] = ['Classic', 'Micro', 'Low Poly', 'Cyberpunk'];
const VOXEL_SIZES: VoxelSizeLabel[] = ['Micro', 'Classic', 'Large'];

const PRESETS = [
  { name: 'Cyberpunk City', prompt: 'A neon-drenched cyberpunk street with hover-cars and glowing signs', style: 'Cyberpunk' as VoxelStyle, icon: '🏙️' },
  { name: 'Fantasy Forest', prompt: 'An enchanted forest with glowing mushrooms and a hidden treehouse', style: 'Low Poly' as VoxelStyle, icon: '🌲' },
  { name: 'Sci-Fi Interior', prompt: 'The bridge of a futuristic spaceship with holographic consoles', style: 'Micro' as VoxelStyle, icon: '🚀' },
  { name: 'Ancient Ruins', prompt: 'Overgrown stone ruins of a forgotten desert temple', style: 'Classic' as VoxelStyle, icon: '🏛️' },
  { name: 'Underwater Kingdom', prompt: 'A majestic coral castle with glowing jellyfish and bioluminescent sea life', style: 'Low Poly' as VoxelStyle, icon: '🏰' },
  { name: 'Alien Planet', prompt: 'Strange crystalline formations and purple flora on a foreign world with two moons', style: 'Micro' as VoxelStyle, icon: '🪐' },
  { name: 'Haunted Mansion', prompt: 'A spooky Victorian mansion with ghostly apparitions and twisted iron gates', style: 'Classic' as VoxelStyle, icon: '👻' },
  { name: 'Steampunk City', prompt: 'Brass pipes, steam engines, and giant clockwork gears in a Victorian industrial city', style: 'Cyberpunk' as VoxelStyle, icon: '⚙️' },
  { name: 'Fairy Tale Village', prompt: 'Quaint cottages with thatched roofs and flower gardens in a peaceful valley', style: 'Low Poly' as VoxelStyle, icon: '🍄' },
  { name: 'Volcanic Peak', prompt: 'A dark volcanic mountain with flowing lava and black obsidian rocks', style: 'Classic' as VoxelStyle, icon: '🌋' },
  { name: 'Art Deco City', prompt: 'Gleaming skyscrapers with gold accents, geometric patterns, and marble statues in 1920s style', style: 'Classic' as VoxelStyle, icon: '🎷' },
  { name: 'Wild West', prompt: 'A dusty wooden saloon and general store in a desert town at high noon with cacti', style: 'Classic' as VoxelStyle, icon: '🤠' },
  { name: 'Zen Garden', prompt: 'A peaceful Japanese garden with raked sand patterns, bonsai trees, and koi ponds', style: 'Low Poly' as VoxelStyle, icon: '🎋' },
  { name: 'Glitch Dimension', prompt: 'Abstract floating geometric shapes with corrupted textures, wireframes, and neon artifacts', style: 'Cyberpunk' as VoxelStyle, icon: '👾' },
  { name: 'Arctic Outpost', prompt: 'A scientific research station on a frozen glacier with snow vehicles and aurora borealis', style: 'Micro' as VoxelStyle, icon: '❄️' },
];

const App: React.FC = () => {
  // UI State
  const [status, setStatus] = useState<AppStatus>('idle');
  const isLoading = useMemo(() => status === 'generating_image' || status === 'generating_voxels', [status]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showGenerator, setShowGenerator] = useState(false);
  const [activeTab, setActiveTab] = useState<InspectorTab>('transform');
  const [viewMode, setViewMode] = useState<'image' | 'voxel'>('image');
  const [thinkingText, setThinkingText] = useState<string | null>(null);

  // Scene Configuration
  const [prompt, setPrompt] = useState('');
  const [imageData, setImageData] = useState<string | null>(null);
  const [voxelCode, setVoxelCode] = useState<string | null>(null);
  const [palette, setPalette] = useState<string[]>(['#FF0000', '#00FF00', '#0000FF', '#000000', '#FFFFFF']);
  const [bgColor, setBgColor] = useState('#ffffff');
  const [autoRotate, setAutoRotate] = useState(true);
  const [lightIntensity, setLightIntensity] = useState(1.0);
  const [fogDensity, setFogDensity] = useState(0.5);
  const [style, setStyle] = useState<VoxelStyle>('Classic');
  const [voxelSizeLabel, setVoxelSizeLabel] = useState<VoxelSizeLabel>('Classic');
  const [ratio, setRatio] = useState('1:1');
  const [physicsOn, setPhysicsOn] = useState(false);

  // Tools
  const [currentTool, setCurrentTool] = useState<ToolMode>('view');
  const [selectedPaletteIndex, setSelectedPaletteIndex] = useState(0);
  // Track edit history availability from the iframe
  const [editHistory, setEditHistory] = useState({ canUndo: false, canRedo: false });

  // Export Settings
  const [exportFormat, setExportFormat] = useState<ExportFormat>('GLTF');
  const [optimizeExport, setOptimizeExport] = useState(true);
  const [exportLOD, setExportLOD] = useState('High');

  // Persistence & History
  const [history, setHistory] = useState<SceneState[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [vault, setVault] = useState<SavedScene[]>([]);
  const [selectedId, setSelectedId] = useState<string | 'user' | null>(null);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingSave = useRef<((url: string) => void) | null>(null);

  // --- Effects ---
  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) try { setVault(JSON.parse(raw)); } catch (e) { localStorage.removeItem(STORAGE_KEY); }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(vault.slice(0, 50)));
  }, [vault]);

  // Reset local edit history when scene changes
  useEffect(() => {
     setEditHistory({ canUndo: false, canRedo: false });
  }, [voxelCode]);

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (!e.data) return;
      if (e.data.type === 'SNAPSHOT_RESULT' && pendingSave.current) {
        pendingSave.current(e.data.dataUrl);
        pendingSave.current = null;
      }
      if (e.data.type === 'EXPORT_RESULT') {
        const { format, content } = e.data;
        const extension = format.toLowerCase();
        const mimeType = format === 'GLTF' ? 'application/json' : 'text/plain';
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `voxel_forge_${Date.now()}.${extension}`;
        a.click(); URL.revokeObjectURL(url);
        setStatus('idle');
      }
      if (e.data.type === 'HISTORY_STATUS') {
        setEditHistory({ canUndo: e.data.canUndo, canRedo: e.data.canRedo });
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // --- Tool & Bridge Communications ---
  useEffect(() => {
    // Sync Tool
    iframeRef.current?.contentWindow?.postMessage({ type: 'SET_TOOL', tool: currentTool }, '*');
    // If not View, ensure autoRotate is off logic is handled inside bridge, 
    // but we can also force it via state here to be consistent.
    if (currentTool !== 'view' && autoRotate) {
       setAutoRotate(false);
       handlePatch({ autoRotate: false });
    }
  }, [currentTool]);

  useEffect(() => {
    // Sync active color for paint
    if (palette[selectedPaletteIndex]) {
       iframeRef.current?.contentWindow?.postMessage({ type: 'SET_COLOR', color: palette[selectedPaletteIndex] }, '*');
    }
  }, [selectedPaletteIndex, palette]);


  // --- Core Logic ---
  const getCurrentState = useCallback((): SceneState => ({
    image: imageData || '', voxel: voxelCode, prompt, palette, 
    backgroundColor: bgColor, autoRotate, lightIntensity, fogDensity, style,
    voxelSize: voxelSizeLabel
  }), [imageData, voxelCode, prompt, palette, bgColor, autoRotate, lightIntensity, fogDensity, style, voxelSizeLabel]);

  const commitToHistory = useCallback((state: SceneState) => {
    setHistory(prev => {
      const up = prev.slice(0, historyIdx + 1);
      up.push(state);
      return up.slice(-20);
    });
    setHistoryIdx(prev => Math.min(prev + 1, 19));
  }, [historyIdx]);

  const applyHistoryState = (idx: number) => {
    const s = history[idx];
    if (!s) return;
    setImageData(s.image); setVoxelCode(s.voxel); setPrompt(s.prompt); setPalette(s.palette);
    setBgColor(s.backgroundColor); setAutoRotate(s.autoRotate); setLightIntensity(s.lightIntensity);
    setFogDensity(s.fogDensity); setStyle(s.style); setVoxelSizeLabel(s.voxelSize);
    setHistoryIdx(idx);
  };

  const handleGenImage = async () => {
    if (!prompt) return;
    setStatus('generating_image'); setErrorMsg(null);
    try {
      const url = await generateImage(prompt, ratio);
      setImageData(url); setVoxelCode(null); setViewMode('image');
      commitToHistory({ ...getCurrentState(), image: url, voxel: null });
      setStatus('idle'); setShowGenerator(false); setSelectedId('user');
    } catch (e: any) { setStatus('error'); setErrorMsg(e.message); }
  };

  const handleTransmute = async () => {
    if (!imageData) return;
    setStatus('generating_voxels'); setErrorMsg(null); setThinkingText(null);
    try {
      const numericSize = VOXEL_SIZE_MAP[voxelSizeLabel];
      const raw = await generateVoxelScene(imageData, setThinkingText, palette, numericSize);
      // Chain injectors: Basic -> Physics -> Bridge -> Interactions -> Params
      const prepped = updateSceneParameters(
        setCameraView(
          injectInteractionBridge(
            injectVoxelPhysics(
              injectExporterBridge(
                injectSubtleAnimation(hideBodyText(raw))
              )
            )
          ), 
          { x: 40, y: 40, z: 40 }
        ),
        { backgroundColor: bgColor, autoRotate, lightIntensity, fogDensity }
      );
      setVoxelCode(prepped); setViewMode('voxel');
      commitToHistory({ ...getCurrentState(), voxel: prepped });
      setStatus('idle');
    } catch (e: any) { setStatus('error'); setErrorMsg(e.message); }
  };

  const handleSave = async () => {
    if (!imageData) return;
    setStatus('saving');
    const thumb: string = await new Promise(res => {
      if (!iframeRef.current?.contentWindow || !voxelCode) return res(imageData);
      pendingSave.current = res;
      iframeRef.current.contentWindow.postMessage({ type: 'GET_SNAPSHOT' }, '*');
      setTimeout(() => { if (pendingSave.current === res) res(imageData); }, 1500);
    });
    const s: SavedScene = { ...getCurrentState(), image: imageData, id: `s_${Date.now()}`, timestamp: Date.now(), thumbnail: thumb };
    setVault(prev => [s, ...prev]); setStatus('idle');
  };

  const loadVaultScene = (s: SavedScene) => {
    setImageData(s.image); setVoxelCode(s.voxel); setPrompt(s.prompt); setPalette(s.palette);
    setBgColor(s.backgroundColor); setAutoRotate(s.autoRotate); setLightIntensity(s.lightIntensity);
    setFogDensity(s.fogDensity); setStyle(s.style); setVoxelSizeLabel(s.voxelSize);
    setViewMode(s.voxel ? 'voxel' : 'image');
    setSelectedId(s.id); setShowGenerator(false);
  };

  const handlePatch = (overrides: Partial<SceneState>) => {
    if (!voxelCode) return;
    const up = updateSceneParameters(voxelCode, { 
      backgroundColor: overrides.backgroundColor ?? bgColor, 
      autoRotate: overrides.autoRotate ?? autoRotate, 
      lightIntensity: overrides.lightIntensity ?? lightIntensity, 
      fogDensity: overrides.fogDensity ?? fogDensity 
    });
    setVoxelCode(up);
  };

  const handleExport = () => {
    if (iframeRef.current?.contentWindow) {
      setStatus('saving');
      iframeRef.current.contentWindow.postMessage({ 
        type: 'EXPORT_SCENE', 
        format: exportFormat,
        options: {
          optimize: optimizeExport,
          lod: exportLOD
        }
      }, '*');
    }
  };

  const togglePhysics = (on: boolean) => { setPhysicsOn(on); iframeRef.current?.contentWindow?.postMessage({ type: 'TOGGLE_PHYSICS', enabled: on }, '*'); };
  const resetPhysics = () => iframeRef.current?.contentWindow?.postMessage({ type: 'RESET_PHYSICS' }, '*');

  // --- Palette Management ---
  const addPaletteColor = () => setPalette([...palette, '#333333']);
  const removePaletteColor = (index: number) => {
    const newPalette = palette.filter((_, i) => i !== index);
    setPalette(newPalette);
    if (selectedPaletteIndex >= newPalette.length) setSelectedPaletteIndex(Math.max(0, newPalette.length - 1));
  };
  const updatePaletteColor = (index: number, color: string) => {
    const newPalette = [...palette];
    newPalette[index] = color;
    setPalette(newPalette);
  };
  const movePaletteColor = (index: number, direction: 'left' | 'right') => {
    if (direction === 'left' && index === 0) return;
    if (direction === 'right' && index === palette.length - 1) return;
    const newPalette = [...palette];
    const targetIndex = direction === 'left' ? index - 1 : index + 1;
    [newPalette[index], newPalette[targetIndex]] = [newPalette[targetIndex], newPalette[index]];
    setPalette(newPalette);
    if (selectedPaletteIndex === index) setSelectedPaletteIndex(targetIndex);
    else if (selectedPaletteIndex === targetIndex) setSelectedPaletteIndex(index);
  };

  // --- Undo / Redo Handlers ---
  const handleUndo = () => {
    if (editHistory.canUndo) {
      iframeRef.current?.contentWindow?.postMessage({ type: 'UNDO_EDIT' }, '*');
    } else if (historyIdx > 0) {
      applyHistoryState(historyIdx - 1);
    }
  };

  const handleRedo = () => {
    if (editHistory.canRedo) {
      iframeRef.current?.contentWindow?.postMessage({ type: 'REDO_EDIT' }, '*');
    } else if (historyIdx < history.length - 1) {
      applyHistoryState(historyIdx + 1);
    }
  };

  const canUndo = editHistory.canUndo || historyIdx > 0;
  const canRedo = editHistory.canRedo || historyIdx < history.length - 1;

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 font-sans p-6 md:p-12 overflow-x-hidden selection:bg-yellow-200">
      <style>{`.loading-dots::after { content: ''; animation: dots 1.5s infinite; } @keyframes dots { 0% { content: ''; } 33% { content: '.'; } 66% { content: '..'; } 100% { content: '...'; } }`}</style>

      <div className="max-w-6xl mx-auto space-y-12">
        <header className="flex flex-col md:flex-row justify-between items-start md:items-end border-b-4 border-black pb-8 gap-6">
          <div className="space-y-2">
            <h1 className="text-7xl md:text-9xl font-black uppercase tracking-tighter leading-[0.8]">VOXEL<br/>FORGE</h1>
            <p className="text-stone-400 font-bold uppercase text-xs tracking-[0.4em]">Engine v5.0 // Advanced AI Transmutation</p>
          </div>
          <div className="flex gap-4">
            <button onClick={() => setShowGenerator(true)} className="px-8 py-4 bg-black text-white font-black uppercase text-sm shadow-[8px_8px_0px_0px_rgba(0,0,0,0.2)] hover:bg-stone-800 transition-all active:translate-y-1 active:shadow-none">Open Foundry</button>
          </div>
        </header>

        {/* Artifact Vault */}
        <section className="space-y-4">
          <h2 className="text-[10px] font-black uppercase tracking-[0.3em] text-stone-300">Personal Artifact Vault</h2>
          <div className="flex gap-4 overflow-x-auto pb-6 hide-scrollbar">
            <button onClick={() => { setSelectedId('user'); setShowGenerator(true); }} className={`min-w-[140px] aspect-square border-4 border-black flex flex-col items-center justify-center bg-white shadow-[6px_6px_0px_0px_black] active:translate-y-1 active:shadow-none transition-all ${selectedId === 'user' ? 'bg-yellow-300' : 'hover:bg-stone-50'}`}>
              <span className="text-4xl font-black">+</span>
              <span className="text-[10px] font-black uppercase mt-2">New Entry</span>
            </button>
            {vault.map(s => (
              <div key={s.id} className="relative group shrink-0">
                <button onClick={() => loadVaultScene(s)} className={`min-w-[140px] aspect-square border-4 border-black overflow-hidden relative transition-all ${selectedId === s.id ? 'scale-105 shadow-[8px_8px_0px_0px_black] z-10 border-yellow-400' : 'hover:-translate-y-1 shadow-[4px_4px_0px_0px_black]'}`}>
                  <img src={s.thumbnail} className="w-full h-full object-cover" alt="" />
                </button>
                <button onClick={(e) => { e.stopPropagation(); setVault(v => v.filter(x => x.id !== s.id)); }} className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 border-2 border-black rounded-full text-white text-xs font-black opacity-0 group-hover:opacity-100 transition-all hover:scale-110">×</button>
              </div>
            ))}
          </div>
        </section>

        {/* Generator Panel */}
        {showGenerator && (
          <div className="bg-white border-4 border-black p-8 shadow-[12px_12px_0px_0px_black] animate-in slide-in-from-top-4 duration-300 space-y-10">
            <div className="space-y-4">
              <label className="text-xs font-black uppercase">Rapid Presets</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
                {PRESETS.map(p => (
                  <button key={p.name} onClick={() => { setPrompt(p.prompt); setStyle(p.style); }} className="p-4 border-2 border-black hover:bg-yellow-300 transition-all flex flex-col items-center gap-2 group active:translate-y-0.5">
                    <span className="text-3xl group-hover:scale-110 transition-transform">{p.icon}</span>
                    <span className="text-[10px] font-black uppercase text-center leading-none">{p.name}</span>
                  </button>
                ))}
              </div>
            </div>
            
            {/* Palette Manager */}
            <div className="space-y-4">
              <div className="flex justify-between items-end">
                <label className="text-xs font-black uppercase">Voxel Color Chromatics</label>
                <button onClick={addPaletteColor} className="text-[10px] font-black uppercase border-2 border-black px-2 py-1 hover:bg-stone-100 transition-colors">Add Color</button>
              </div>
              <div className="flex gap-3 overflow-x-auto pb-4 hide-scrollbar min-h-[100px] items-center">
                {palette.map((color, index) => (
                  <div key={index} className="flex flex-col items-center gap-2 shrink-0 animate-in zoom-in-50 duration-200">
                    <div className="w-14 h-14 border-4 border-black shadow-[4px_4px_0px_0px_black] relative group overflow-hidden">
                      <input 
                        type="color" 
                        value={color} 
                        onChange={e => updatePaletteColor(index, e.target.value)} 
                        className="absolute inset-0 w-full h-full scale-150 cursor-pointer" 
                      />
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => movePaletteColor(index, 'left')} disabled={index === 0} className="w-5 h-5 flex items-center justify-center border border-black text-[10px] hover:bg-stone-100 disabled:opacity-20 transition-all">←</button>
                      <button onClick={() => removePaletteColor(index)} className="w-5 h-5 flex items-center justify-center border border-black text-[10px] hover:bg-red-500 hover:text-white transition-all">×</button>
                      <button onClick={() => movePaletteColor(index, 'right')} disabled={index === palette.length - 1} className="w-5 h-5 flex items-center justify-center border border-black text-[10px] hover:bg-stone-100 disabled:opacity-20 transition-all">→</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-12">
              <div className="space-y-4">
                <label className="text-xs font-black uppercase">Visual Seed</label>
                <div onClick={() => fileRef.current?.click()} className="h-60 border-4 border-dashed border-black bg-stone-50 flex flex-col items-center justify-center cursor-pointer hover:bg-stone-100 transition-all relative overflow-hidden group">
                  <input type="file" ref={fileRef} className="hidden" onChange={e => { const f = e.target.files?.[0]; if(f){ const r = new FileReader(); r.onload=v=>setImageData(v.target?.result as string); r.readAsDataURL(f); } }} />
                  {imageData && <img src={imageData} className="absolute inset-0 w-full h-full object-cover opacity-20 group-hover:opacity-30 transition-opacity" alt="" />}
                  <div className="relative z-10 text-center">
                    <span className="text-4xl mb-2 block">🖼️</span>
                    <span className="text-[10px] font-black uppercase">Drop Source or Click</span>
                  </div>
                </div>
              </div>
              <div className="space-y-6">
                <div className="space-y-2">
                  <label className="text-xs font-black uppercase">Manifestation Prompt</label>
                  <textarea value={prompt} onChange={e => setPrompt(e.target.value)} className="w-full h-32 p-4 border-4 border-black focus:ring-0 focus:outline-none font-bold text-lg resize-none placeholder:text-stone-200" placeholder="A futuristic pagoda floating in a neon cloudscape..." />
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <label className="text-[9px] font-black uppercase text-stone-400">Dimensions</label>
                    <select value={ratio} onChange={e => setRatio(e.target.value)} className="w-full p-3 border-2 border-black font-black uppercase text-xs bg-white">
                      {ASPECT_RATIOS.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[9px] font-black uppercase text-stone-400">Art Style</label>
                    <select value={style} onChange={e => setStyle(e.target.value as VoxelStyle)} className="w-full p-3 border-2 border-black font-black uppercase text-xs bg-white">
                      {STYLES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[9px] font-black uppercase text-stone-400">Voxel Size</label>
                    <select value={voxelSizeLabel} onChange={e => setVoxelSizeLabel(e.target.value as VoxelSizeLabel)} className="w-full p-3 border-2 border-black font-black uppercase text-xs bg-white">
                      {VOXEL_SIZES.map(s => <option key={s} value={s}>{s} ({VOXEL_SIZE_MAP[s]})</option>)}
                    </select>
                  </div>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-4 pt-6 border-t-2 border-stone-100">
              <button onClick={() => setShowGenerator(false)} className="px-8 py-3 font-black uppercase text-xs hover:bg-stone-100 transition-colors">Cancel</button>
              <button onClick={handleGenImage} disabled={isLoading || !prompt} className="px-10 py-4 bg-black text-white font-black uppercase shadow-[6px_6px_0px_0px_rgba(0,0,0,0.3)] hover:bg-yellow-300 hover:text-black transition-all disabled:opacity-30">Ignite Engine</button>
            </div>
          </div>
        )}

        {/* Forge Viewport */}
        {imageData && (
          <div className="grid md:grid-cols-12 gap-8 items-start">
            <div className="md:col-span-8 space-y-6">
              <div className="aspect-square bg-stone-200 border-4 border-black relative shadow-[16px_16px_0px_0px_black] overflow-hidden group">
                {/* Tools Overlay */}
                {viewMode === 'voxel' && voxelCode && (
                   <div className="absolute top-4 left-4 z-20 flex flex-col gap-2">
                      <div className="bg-white border-2 border-black p-1 shadow-[4px_4px_0px_0px_black] flex flex-col gap-1">
                        <button onClick={() => setCurrentTool('view')} className={`p-2 border border-black hover:bg-yellow-100 transition-colors ${currentTool === 'view' ? 'bg-black text-white' : ''}`} title="View Camera">
                           👁️
                        </button>
                        <button onClick={() => setCurrentTool('paint')} className={`p-2 border border-black hover:bg-yellow-100 transition-colors ${currentTool === 'paint' ? 'bg-black text-white' : ''}`} title="Paint Voxel">
                           🖌️
                        </button>
                        <button onClick={() => setCurrentTool('erase')} className={`p-2 border border-black hover:bg-yellow-100 transition-colors ${currentTool === 'erase' ? 'bg-black text-white' : ''}`} title="Erase Voxel">
                           🧹
                        </button>
                      </div>

                      {/* Mini Palette for Painting */}
                      {currentTool === 'paint' && (
                        <div className="bg-white border-2 border-black p-2 shadow-[4px_4px_0px_0px_black] grid grid-cols-2 gap-1 w-20">
                           {palette.map((c, i) => (
                             <button 
                               key={i} 
                               onClick={() => setSelectedPaletteIndex(i)} 
                               className={`w-6 h-6 border border-black ${selectedPaletteIndex === i ? 'ring-2 ring-black ring-offset-1' : ''}`}
                               style={{backgroundColor: c}}
                             />
                           ))}
                        </div>
                      )}
                   </div>
                )}

                {isLoading && (
                  <div className="absolute inset-0 z-50 bg-white/95 p-12 flex flex-col justify-center animate-in fade-in duration-500">
                    <h3 className="text-5xl font-black uppercase italic mb-6 animate-pulse">Forging Artifact<span className="loading-dots"></span></h3>
                    <div className="font-mono text-[10px] text-stone-400 border-l-4 border-black pl-4 py-4 bg-stone-50 max-h-40 overflow-y-auto uppercase leading-tight">
                      {thinkingText || "Transmuting pixels into 3D voxel coordinate arrays..."}
                    </div>
                  </div>
                )}
                {(status === 'saving') && (
                  <div className="absolute inset-0 z-50 bg-black/60 flex flex-col items-center justify-center backdrop-blur-md">
                     <div className="w-10 h-10 border-4 border-white border-t-transparent rounded-full animate-spin mb-4"></div>
                     <span className="text-white font-black uppercase text-xs tracking-widest animate-pulse">Processing Export Data...</span>
                  </div>
                )}
                {viewMode === 'image' && <img src={imageData} className="w-full h-full object-contain" alt="Subject" />}
                {viewMode === 'voxel' && voxelCode && <iframe ref={iframeRef} srcDoc={voxelCode} className="w-full h-full border-none" sandbox="allow-scripts allow-same-origin" />}
              </div>
              <div className="flex gap-4">
                <button onClick={() => setViewMode(v => v === 'image' ? 'voxel' : 'image')} disabled={!voxelCode} className={`flex-1 py-4 border-4 border-black font-black uppercase shadow-[6px_6px_0px_0px_black] transition-all active:translate-y-1 active:shadow-none ${viewMode === 'voxel' ? 'bg-black text-white' : 'bg-white hover:bg-stone-100'}`}>Toggle Perspective</button>
                <button onClick={handleTransmute} disabled={isLoading} className="flex-1 py-4 bg-yellow-300 border-4 border-black font-black uppercase shadow-[6px_6px_0px_0px_black] hover:bg-black hover:text-white transition-all active:translate-y-1 active:shadow-none">Transmute Subject</button>
              </div>
            </div>

            <div className="md:col-span-4 space-y-6">
              <div className="bg-white border-4 border-black shadow-[8px_8px_0px_0px_black] overflow-hidden">
                <div className="flex border-b-4 border-black bg-stone-100">
                  {(['transform', 'atmosphere', 'physics', 'export'] as InspectorTab[]).map(t => (
                    <button key={t} onClick={() => setActiveTab(t)} className={`flex-1 py-3 text-[9px] font-black uppercase tracking-widest transition-colors border-r-2 last:border-r-0 border-black ${activeTab === t ? 'bg-black text-white' : 'bg-white hover:bg-stone-50'}`}>{t}</button>
                  ))}
                </div>
                <div className="p-6 space-y-6">
                  {activeTab === 'transform' && (
                    <div className="space-y-4">
                      <label className="text-[10px] font-black uppercase text-stone-400">Quick Camera</label>
                      <div className="grid grid-cols-2 gap-2">
                        {['isometric', 'top', 'front', 'side'].map(a => (
                          <button key={a} onClick={() => { if (voxelCode) {
                            const v = { isometric: {x:40, y:40, z:40}, top: {x:0.1, y:60, z:0}, front: {x:0, y:10, z:60}, side: {x:60, y:10, z:0} };
                            setVoxelCode(setCameraView(voxelCode, v[a as keyof typeof v]));
                          }}} className="py-2 border-2 border-black font-black text-[9px] uppercase hover:bg-black hover:text-white transition-all">View {a}</button>
                        ))}
                      </div>
                      <button onClick={() => { setAutoRotate(!autoRotate); handlePatch({ autoRotate: !autoRotate }); }} className={`w-full py-3 border-2 border-black font-black uppercase text-[10px] transition-all ${autoRotate ? 'bg-black text-white' : 'bg-white hover:bg-stone-100'}`}>Orbit Rotation: {autoRotate ? 'ON' : 'OFF'}</button>
                    </div>
                  )}
                  {activeTab === 'atmosphere' && (
                    <div className="space-y-6">
                      <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase text-stone-400">Luminance</label>
                        <input type="range" min="0" max="3" step="0.1" value={lightIntensity} onChange={e => { setLightIntensity(Number(e.target.value)); handlePatch({ lightIntensity: Number(e.target.value) }); }} className="w-full accent-black cursor-pointer" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase text-stone-400">Aether Density</label>
                        <input type="range" min="0" max="1" step="0.1" value={fogDensity} onChange={e => { setFogDensity(Number(e.target.value)); handlePatch({ fogDensity: Number(e.target.value) }); }} className="w-full accent-black cursor-pointer" />
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 border-2 border-black shadow-[3px_3px_0px_0px_black] overflow-hidden">
                          <input type="color" value={bgColor} onChange={e => { setBgColor(e.target.value); handlePatch({ backgroundColor: e.target.value }); }} className="w-full h-full cursor-pointer scale-150" />
                        </div>
                        <span className="text-[10px] font-mono font-bold uppercase border-b border-black pb-1">{bgColor}</span>
                      </div>
                    </div>
                  )}
                  {activeTab === 'physics' && (
                    <div className="space-y-4">
                      <div className="bg-yellow-50 p-3 border-2 border-black text-[9px] font-bold uppercase italic leading-tight">Cellular Gravity enabled: Simulates block stability and collisions.</div>
                      <button onClick={() => togglePhysics(!physicsOn)} disabled={!voxelCode} className={`w-full py-4 border-2 border-black font-black uppercase text-xs shadow-[4px_4px_0px_0px_black] active:translate-y-1 active:shadow-none transition-all ${physicsOn ? 'bg-green-400' : 'bg-white hover:bg-stone-50'}`}>{physicsOn ? 'Simulation Active' : 'Enable Physics'}</button>
                      <button onClick={resetPhysics} disabled={!voxelCode} className="w-full py-2 border-2 border-black font-black uppercase text-[10px] hover:bg-red-500 hover:text-white transition-all bg-white">Reset Settlement</button>
                    </div>
                  )}
                  {activeTab === 'export' && (
                    <div className="space-y-6">
                      <div className="space-y-4 border-b-2 border-stone-100 pb-4">
                        <div className="space-y-1">
                          <label className="text-[10px] font-black uppercase text-stone-400">Target Format</label>
                          <select value={exportFormat} onChange={e => setExportFormat(e.target.value as ExportFormat)} className="w-full p-2 border-2 border-black font-black uppercase text-xs bg-white">
                            <option value="GLTF">GLTF (Full Scene)</option>
                            <option value="OBJ">Wavefront OBJ (Mesh)</option>
                            <option value="VOX">MagicaVoxel JSON</option>
                          </select>
                        </div>
                        <div className="flex items-center gap-2">
                           <input type="checkbox" id="optimize" checked={optimizeExport} onChange={e => setOptimizeExport(e.target.checked)} className="w-4 h-4 accent-black" />
                           <label htmlFor="optimize" className="text-[10px] font-black uppercase cursor-pointer">Optimize Mesh (Greedy LOD)</label>
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] font-black uppercase text-stone-400">Resolution (LOD)</label>
                          <select value={exportLOD} onChange={e => setExportLOD(e.target.value)} className="w-full p-2 border-2 border-black font-black uppercase text-xs bg-white">
                            <option value="High">Native (High Detail)</option>
                            <option value="Med">Balanced (Compressed)</option>
                            <option value="Low">Low Poly (Draft)</option>
                          </select>
                        </div>
                      </div>
                      <button onClick={handleExport} disabled={!voxelCode || status === 'saving'} className="w-full py-4 bg-black text-white border-2 border-black font-black uppercase text-xs shadow-[6px_6px_0px_0px_rgba(0,0,0,0.3)] hover:bg-yellow-300 hover:text-black transition-all active:translate-y-1 active:shadow-none">Generate Advanced Export</button>
                    </div>
                  )}
                </div>
                <div className="p-4 border-t-2 border-stone-100 bg-stone-50 flex gap-2">
                  <button onClick={handleUndo} disabled={!canUndo} className="flex-1 py-1 border-2 border-black text-[8px] font-black uppercase bg-white disabled:opacity-20 hover:bg-stone-100 transition-colors">Undo</button>
                  <button onClick={handleRedo} disabled={!canRedo} className="flex-1 py-1 border-2 border-black text-[8px] font-black uppercase bg-white disabled:opacity-20 hover:bg-stone-100 transition-colors">Redo</button>
                  <button onClick={handleSave} disabled={status === 'saving' || !imageData} className="flex-1 py-1 bg-yellow-300 border-2 border-black text-[8px] font-black uppercase shadow-[3px_3px_0px_0px_black] active:shadow-none transition-all disabled:opacity-30 hover:bg-yellow-400">Secure Vault</button>
                </div>
              </div>
              {errorMsg && <div className="p-4 bg-red-50 border-4 border-red-500 text-red-700 text-[10px] font-black uppercase tracking-tighter">Forge Error: {errorMsg}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
