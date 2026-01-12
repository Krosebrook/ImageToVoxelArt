
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
type AppStatus = 'idle' | 'generating_image' | 'generating_voxels' | 'error' | 'saving' | 'optimizing';
type VoxelStyle = 'Classic' | 'Micro' | 'Low Poly' | 'Cyberpunk';
type VoxelSizeLabel = 'Micro' | 'Classic' | 'Large';
type InspectorTab = 'transform' | 'atmosphere' | 'physics' | 'dashboard' | 'export';
type ExportFormat = 'OBJ' | 'VOX' | 'GLTF';
type ToolMode = 'view' | 'paint' | 'erase' | 'add' | 'pick';

interface ColorEntry {
  hex: string;
  glow: boolean;
}

const VOXEL_SIZE_MAP: Record<VoxelSizeLabel, number> = {
  'Micro': 0.5,
  'Classic': 1.0,
  'Large': 2.0
};

interface SceneState {
  image: string;
  voxel: string | null;
  prompt: string;
  palette: ColorEntry[];
  backgroundColor: string;
  autoRotate: boolean;
  lightIntensity: number;
  fogDensity: number;
  style: VoxelStyle;
  voxelSize: VoxelSizeLabel;
  skyPreset?: string;
}

interface SavedScene extends SceneState {
  id: string;
  timestamp: number;
  thumbnail: string;
}

interface SceneMetrics {
  totalVoxels: number;
  userVoxels: number;
  uniqueColors: number;
  estimatedMemory: string;
}

// --- Constants ---
const STORAGE_KEY = 'voxel_forge_v6_pro';
const ASPECT_RATIOS = ["1:1", "3:4", "4:3", "16:9", "9:16"];
const STYLES: VoxelStyle[] = ['Classic', 'Micro', 'Low Poly', 'Cyberpunk'];
const VOXEL_SIZES: VoxelSizeLabel[] = ['Micro', 'Classic', 'Large'];

const SKY_PRESETS = [
  { name: 'Default', bg: '#ffffff', fog: 0.5, light: 1.0 },
  { name: 'Studio', bg: '#e5e5e5', fog: 0.1, light: 1.5 },
  { name: 'Sunset', bg: '#ff9a76', fog: 0.8, light: 1.2 },
  { name: 'Midnight', bg: '#0b0e14', fog: 0.4, light: 0.5 },
  { name: 'Forest', bg: '#2d3436', fog: 0.9, light: 0.8 },
  { name: 'Cyber', bg: '#1a1a2e', fog: 0.3, light: 1.4 }
];

const PRESETS = [
  { name: 'Cyberpunk City', prompt: 'A neon-drenched cyberpunk street with hover-cars and glowing signs', style: 'Cyberpunk' as VoxelStyle, icon: '🏙️' },
  { name: 'Fantasy Forest', prompt: 'An enchanted forest with glowing mushrooms and a hidden treehouse', style: 'Low Poly' as VoxelStyle, icon: '🌲' },
  { name: 'Sci-Fi Interior', prompt: 'The bridge of a futuristic spaceship with holographic consoles', style: 'Micro' as VoxelStyle, icon: '🚀' },
  { name: 'Ancient Ruins', prompt: 'Overgrown stone ruins of a forgotten desert temple', style: 'Classic' as VoxelStyle, icon: '🏛️' },
  { name: 'Underwater Kingdom', prompt: 'A majestic coral castle with glowing jellyfish and bioluminescent sea life', style: 'Low Poly' as VoxelStyle, icon: '🏰' },
  { name: 'Alien Planet', prompt: 'Strange crystalline formations and purple flora on a foreign world with two moons', style: 'Micro' as VoxelStyle, icon: '🪐' },
];

// --- Subcomponents ---

const VaultItem: React.FC<{ 
  scene: SavedScene; 
  isSelected: boolean; 
  onSelect: () => void; 
  onDelete: () => void 
}> = ({ scene, isSelected, onSelect, onDelete }) => {
  const [isLoaded, setIsLoaded] = useState(false);

  return (
    <div className="relative group shrink-0">
      <button 
        onClick={onSelect} 
        className={`min-w-[140px] aspect-square border-4 border-black overflow-hidden relative transition-all ${
          isSelected ? 'scale-105 shadow-[8px_8px_0px_0px_black] z-10 border-yellow-400' : 'hover:-translate-y-1 shadow-[4px_4px_0px_0px_black]'
        }`}
      >
        {!isLoaded && <div className="absolute inset-0 bg-stone-200 animate-pulse" />}
        <img 
          src={scene.thumbnail} 
          loading="lazy"
          onLoad={() => setIsLoaded(true)}
          className={`w-full h-full object-cover transition-opacity duration-300 ${isLoaded ? 'opacity-100' : 'opacity-0'}`} 
          alt={scene.prompt} 
        />
      </button>
      <button 
        onClick={(e) => { e.stopPropagation(); onDelete(); }} 
        className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 border-2 border-black rounded-full text-white text-xs font-black opacity-0 group-hover:opacity-100 transition-all hover:scale-110 z-20"
      >
        ×
      </button>
    </div>
  );
};

const App: React.FC = () => {
  // UI State
  const [status, setStatus] = useState<AppStatus>('idle');
  const isLoading = useMemo(() => status === 'generating_image' || status === 'generating_voxels' || status === 'optimizing', [status]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showGenerator, setShowGenerator] = useState(false);
  const [activeTab, setActiveTab] = useState<InspectorTab>('transform');
  const [viewMode, setViewMode] = useState<'image' | 'voxel'>('image');
  const [thinkingText, setThinkingText] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<SceneMetrics>({ totalVoxels: 0, userVoxels: 0, uniqueColors: 0, estimatedMemory: '0MB' });

  // Scene Configuration
  const [prompt, setPrompt] = useState('');
  const [imageData, setImageData] = useState<string | null>(null);
  const [voxelCode, setVoxelCode] = useState<string | null>(null);
  const [palette, setPalette] = useState<ColorEntry[]>([
    { hex: '#FF0000', glow: false },
    { hex: '#00FF00', glow: false },
    { hex: '#0000FF', glow: false },
    { hex: '#000000', glow: false },
    { hex: '#FFFFFF', glow: false }
  ]);
  const [bgColor, setBgColor] = useState('#ffffff');
  const [autoRotate, setAutoRotate] = useState(true);
  const [lightIntensity, setLightIntensity] = useState(1.0);
  const [fogDensity, setFogDensity] = useState(0.5);
  const [style, setStyle] = useState<VoxelStyle>('Classic');
  const [voxelSizeLabel, setVoxelSizeLabel] = useState<VoxelSizeLabel>('Classic');
  const [ratio, setRatio] = useState('1:1');
  const [physicsOn, setPhysicsOn] = useState(false);
  const [activeSky, setActiveSky] = useState('Default');

  // Tools
  const [currentTool, setCurrentTool] = useState<ToolMode>('view');
  const [selectedPaletteIndex, setSelectedPaletteIndex] = useState(0);
  const [editHistory, setEditHistory] = useState({ canUndo: false, canRedo: false });

  // Export Settings
  const [exportFormat, setExportFormat] = useState<ExportFormat>('GLTF');
  const [optimizeExport, setOptimizeExport] = useState(true);
  const [exportLOD, setExportLOD] = useState('High');
  const [useTextureAtlas, setUseTextureAtlas] = useState(false);
  const [bakeAO, setBakeAO] = useState(false);

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
      if (e.data.type === 'SCENE_METRICS') {
        setMetrics(e.data.metrics);
      }
      if (e.data.type === 'PICK_COLOR') {
        const hex = e.data.color;
        const idx = palette.findIndex(p => p.hex.toLowerCase() === hex.toLowerCase());
        if (idx !== -1) {
           setSelectedPaletteIndex(idx);
        } else {
           const newPalette = [...palette];
           if (newPalette.length < 12) {
              newPalette.push({ hex, glow: false });
              setPalette(newPalette);
              setSelectedPaletteIndex(newPalette.length - 1);
           } else {
              newPalette[selectedPaletteIndex] = { hex, glow: false };
              setPalette(newPalette);
           }
        }
        setCurrentTool('paint');
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [palette, selectedPaletteIndex]);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'SET_TOOL', tool: currentTool }, '*');
    if (currentTool !== 'view' && autoRotate) {
       setAutoRotate(false);
       handlePatch({ autoRotate: false });
    }
  }, [currentTool]);

  useEffect(() => {
    const entry = palette[selectedPaletteIndex];
    if (entry) {
       iframeRef.current?.contentWindow?.postMessage({ 
         type: 'SET_COLOR', 
         color: entry.hex,
         glow: entry.glow 
       }, '*');
    }
  }, [selectedPaletteIndex, palette]);

  const getCurrentState = useCallback((): SceneState => ({
    image: imageData || '', voxel: voxelCode, prompt, palette, 
    backgroundColor: bgColor, autoRotate, lightIntensity, fogDensity, style,
    voxelSize: voxelSizeLabel, skyPreset: activeSky
  }), [imageData, voxelCode, prompt, palette, bgColor, autoRotate, lightIntensity, fogDensity, style, voxelSizeLabel, activeSky]);

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
    setActiveSky(s.skyPreset || 'Default');
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
      const raw = await generateVoxelScene(imageData, setThinkingText, palette.map(p => p.hex), numericSize);
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
    setActiveSky(s.skyPreset || 'Default');
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

  const applySkyPreset = (name: string) => {
    const p = SKY_PRESETS.find(x => x.name === name);
    if (!p) return;
    setActiveSky(name);
    setBgColor(p.bg);
    setFogDensity(p.fog);
    setLightIntensity(p.light);
    handlePatch({ backgroundColor: p.bg, fogDensity: p.fog, lightIntensity: p.light });
  };

  const handleExport = () => {
    if (iframeRef.current?.contentWindow) {
      setStatus('saving');
      iframeRef.current.contentWindow.postMessage({ 
        type: 'EXPORT_SCENE', 
        format: exportFormat,
        options: {
          optimize: optimizeExport,
          lod: exportLOD,
          textureAtlas: useTextureAtlas,
          bakeAO: bakeAO
        }
      }, '*');
    }
  };

  const togglePhysics = (on: boolean) => { setPhysicsOn(on); iframeRef.current?.contentWindow?.postMessage({ type: 'TOGGLE_PHYSICS', enabled: on }, '*'); };
  const resetPhysics = () => iframeRef.current?.contentWindow?.postMessage({ type: 'RESET_PHYSICS' }, '*');

  // --- Palette Management ---
  const addPaletteColor = () => setPalette([...palette, { hex: '#333333', glow: false }]);
  const removePaletteColor = (index: number) => {
    const newPalette = palette.filter((_, i) => i !== index);
    setPalette(newPalette);
    if (selectedPaletteIndex >= newPalette.length) setSelectedPaletteIndex(Math.max(0, newPalette.length - 1));
  };
  const updatePaletteColor = (index: number, color: string) => {
    const newPalette = [...palette];
    newPalette[index].hex = color;
    setPalette(newPalette);
  };
  const togglePaletteGlow = (index: number) => {
    const newPalette = [...palette];
    newPalette[index].glow = !newPalette[index].glow;
    setPalette(newPalette);
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

  // --- Optimized Image Import ---
  const handleImageFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus('optimizing');
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 1024;
        const scale = Math.min(1, MAX_WIDTH / img.width);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
        setImageData(canvas.toDataURL('image/jpeg', 0.85));
        setStatus('idle');
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 font-sans p-6 md:p-12 overflow-x-hidden selection:bg-yellow-200">
      <style>{`
        .loading-dots::after { content: ''; animation: dots 1.5s infinite; } 
        @keyframes dots { 0% { content: ''; } 33% { content: '.'; } 66% { content: '..'; } 100% { content: '...'; } }
        .hide-scrollbar::-webkit-scrollbar { display: none; }
        .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        .voxel-cursor-paint { cursor: crosshair; }
        .voxel-cursor-add { cursor: copy; }
        .voxel-cursor-erase { cursor: pointer; }
      `}</style>

      <div className="max-w-6xl mx-auto space-y-12">
        <header className="flex flex-col md:flex-row justify-between items-start md:items-end border-b-4 border-black pb-8 gap-6">
          <div className="space-y-2">
            <h1 className="text-7xl md:text-9xl font-black uppercase tracking-tighter leading-[0.8]">VOXEL<br/>FORGE</h1>
            <div className="flex items-center gap-3">
              <p className="text-stone-400 font-bold uppercase text-xs tracking-[0.4em]">Engine v6.1 // Pro Suite</p>
              <span className="px-2 py-0.5 bg-yellow-300 text-[10px] font-black uppercase border border-black">Opti-Lattice™</span>
            </div>
          </div>
          <div className="flex gap-4">
            <button onClick={() => setShowGenerator(true)} className="px-8 py-4 bg-black text-white font-black uppercase text-sm shadow-[8px_8px_0px_0px_rgba(0,0,0,0.2)] hover:bg-stone-800 transition-all active:translate-y-1 active:shadow-none">Foundry Console</button>
          </div>
        </header>

        {/* Artifact Vault - Optimized with lazy loading */}
        <section className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-[10px] font-black uppercase tracking-[0.3em] text-stone-300">Artifact Repository</h2>
            <span className="text-[9px] font-bold text-stone-400 uppercase">{vault.length} Stored Manifests</span>
          </div>
          <div className="flex gap-4 overflow-x-auto pb-6 hide-scrollbar">
            <button 
              onClick={() => { setSelectedId('user'); setShowGenerator(true); }} 
              className={`min-w-[140px] aspect-square border-4 border-black flex flex-col items-center justify-center bg-white shadow-[6px_6px_0px_0px_black] active:translate-y-1 active:shadow-none transition-all ${selectedId === 'user' ? 'bg-yellow-300' : 'hover:bg-stone-50'}`}
            >
              <span className="text-4xl font-black">+</span>
              <span className="text-[10px] font-black uppercase mt-2">New Entry</span>
            </button>
            {vault.length === 0 && (
              <div className="min-w-[140px] aspect-square border-4 border-dashed border-stone-200 flex flex-col items-center justify-center text-stone-300 italic text-[10px] uppercase text-center p-4">
                No artifacts stored in local cache
              </div>
            )}
            {vault.map(s => (
              <VaultItem 
                key={s.id} 
                scene={s} 
                isSelected={selectedId === s.id} 
                onSelect={() => loadVaultScene(s)} 
                onDelete={() => setVault(v => v.filter(x => x.id !== s.id))}
              />
            ))}
          </div>
        </section>

        {/* Generator Panel */}
        {showGenerator && (
          <div className="bg-white border-4 border-black p-8 shadow-[12px_12px_0px_0px_black] animate-in slide-in-from-top-4 duration-300 space-y-10">
            <div className="space-y-4">
              <label className="text-xs font-black uppercase">Rapid Manifest Presets</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
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
                <label className="text-xs font-black uppercase">Chroma Spectrum & Materials</label>
                <button onClick={addPaletteColor} className="text-[10px] font-black uppercase border-2 border-black px-2 py-1 hover:bg-stone-100 transition-colors">New Channel</button>
              </div>
              <div className="flex gap-3 overflow-x-auto pb-4 hide-scrollbar min-h-[120px] items-start">
                {palette.map((entry, index) => (
                  <div key={index} className="flex flex-col items-center gap-2 shrink-0 animate-in zoom-in-50 duration-200">
                    <div className={`w-14 h-14 border-4 border-black shadow-[4px_4px_0px_0px_black] relative group overflow-hidden ${entry.glow ? 'ring-2 ring-yellow-400 ring-offset-2' : ''}`}>
                      <input 
                        type="color" 
                        value={entry.hex} 
                        onChange={e => updatePaletteColor(index, e.target.value)} 
                        className="absolute inset-0 w-full h-full scale-150 cursor-pointer" 
                      />
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => togglePaletteGlow(index)} className={`w-6 h-6 flex items-center justify-center border border-black text-[10px] transition-all ${entry.glow ? 'bg-yellow-300' : 'bg-white hover:bg-stone-100'}`} title="Toggle Glow (Emissive)">
                        {entry.glow ? '🌟' : '💡'}
                      </button>
                      <button onClick={() => removePaletteColor(index)} className="w-6 h-6 flex items-center justify-center border border-black text-[10px] hover:bg-red-500 hover:text-white transition-all">×</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-12">
              <div className="space-y-4">
                <label className="text-xs font-black uppercase">Visual Seed Source</label>
                <div onClick={() => fileRef.current?.click()} className="h-60 border-4 border-dashed border-black bg-stone-50 flex flex-col items-center justify-center cursor-pointer hover:bg-stone-100 transition-all relative overflow-hidden group">
                  <input type="file" ref={fileRef} className="hidden" accept="image/*" onChange={handleImageFile} />
                  {imageData && <img src={imageData} className="absolute inset-0 w-full h-full object-cover opacity-20 group-hover:opacity-30 transition-opacity" alt="" />}
                  <div className="relative z-10 text-center">
                    <span className="text-4xl mb-2 block">📸</span>
                    <span className="text-[10px] font-black uppercase">Import Frame or Drag-Drop</span>
                  </div>
                </div>
              </div>
              <div className="space-y-6">
                <div className="space-y-2">
                  <label className="text-xs font-black uppercase">Structural Prompt</label>
                  <textarea value={prompt} onChange={e => setPrompt(e.target.value)} className="w-full h-32 p-4 border-4 border-black focus:ring-0 focus:outline-none font-bold text-lg resize-none placeholder:text-stone-200" placeholder="A mechanical dragonfly hovering over a liquid mirror..." />
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-1">
                    <label className="text-[9px] font-black uppercase text-stone-400">Aspect</label>
                    <select value={ratio} onChange={e => setRatio(e.target.value)} className="w-full p-3 border-2 border-black font-black uppercase text-xs bg-white">
                      {ASPECT_RATIOS.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[9px] font-black uppercase text-stone-400">Geometry</label>
                    <select value={style} onChange={e => setStyle(e.target.value as VoxelStyle)} className="w-full p-3 border-2 border-black font-black uppercase text-xs bg-white">
                      {STYLES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[9px] font-black uppercase text-stone-400">Grid Scale</label>
                    <select value={voxelSizeLabel} onChange={e => setVoxelSizeLabel(e.target.value as VoxelSizeLabel)} className="w-full p-3 border-2 border-black font-black uppercase text-xs bg-white">
                      {VOXEL_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-4 pt-6 border-t-2 border-stone-100">
              <button onClick={() => setShowGenerator(false)} className="px-8 py-3 font-black uppercase text-xs hover:bg-stone-100 transition-colors">Dismiss</button>
              <button onClick={handleGenImage} disabled={isLoading || !prompt} className="px-10 py-4 bg-black text-white font-black uppercase shadow-[6px_6px_0px_0px_rgba(0,0,0,0.3)] hover:bg-yellow-300 hover:text-black transition-all disabled:opacity-30">Manifest Inspiration</button>
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
                        <button onClick={() => setCurrentTool('view')} className={`p-2 border border-black hover:bg-yellow-100 transition-colors ${currentTool === 'view' ? 'bg-black text-white' : ''}`} title="View Mode (Orbit)">
                           👁️
                        </button>
                        <button onClick={() => setCurrentTool('add')} className={`p-2 border border-black hover:bg-yellow-100 transition-colors ${currentTool === 'add' ? 'bg-black text-white' : ''}`} title="Construct (Add Voxel)">
                           ➕
                        </button>
                        <button onClick={() => setCurrentTool('paint')} className={`p-2 border border-black hover:bg-yellow-100 transition-colors ${currentTool === 'paint' ? 'bg-black text-white' : ''}`} title="Chroma Application (Paint)">
                           🖌️
                        </button>
                        <button onClick={() => setCurrentTool('erase')} className={`p-2 border border-black hover:bg-yellow-100 transition-colors ${currentTool === 'erase' ? 'bg-black text-white' : ''}`} title="Deconstruct (Erase)">
                           🧹
                        </button>
                        <button onClick={() => setCurrentTool('pick')} className={`p-2 border border-black hover:bg-yellow-100 transition-colors ${currentTool === 'pick' ? 'bg-black text-white' : ''}`} title="Spectrum Sampler (Pick)">
                           🧪
                        </button>
                      </div>

                      {/* Mini Palette for Painting/Building */}
                      {(currentTool === 'paint' || currentTool === 'add') && (
                        <div className="bg-white border-2 border-black p-2 shadow-[4px_4px_0px_0px_black] grid grid-cols-3 gap-1 w-24">
                           {palette.map((entry, i) => (
                             <button 
                               key={i} 
                               onClick={() => setSelectedPaletteIndex(i)} 
                               className={`w-6 h-6 border border-black relative ${selectedPaletteIndex === i ? 'ring-2 ring-black ring-offset-1' : ''}`}
                               style={{backgroundColor: entry.hex}}
                             >
                               {entry.glow && <span className="absolute -top-1 -right-1 text-[6px]">✨</span>}
                             </button>
                           ))}
                        </div>
                      )}
                   </div>
                )}

                {isLoading && (
                  <div className="absolute inset-0 z-50 bg-white/95 p-12 flex flex-col justify-center animate-in fade-in duration-500">
                    <h3 className="text-5xl font-black uppercase italic mb-6 animate-pulse">Forging Lattice<span className="loading-dots"></span></h3>
                    <div className="font-mono text-[10px] text-stone-400 border-l-4 border-black pl-4 py-4 bg-stone-50 max-h-40 overflow-y-auto uppercase leading-tight">
                      {thinkingText || "Synthesizing voxel coordinate streams..."}
                    </div>
                  </div>
                )}
                {(status === 'saving') && (
                  <div className="absolute inset-0 z-50 bg-black/60 flex flex-col items-center justify-center backdrop-blur-md">
                     <div className="w-10 h-10 border-4 border-white border-t-transparent rounded-full animate-spin mb-4"></div>
                     <span className="text-white font-black uppercase text-xs tracking-widest animate-pulse">Encoding Digital Artifact...</span>
                  </div>
                )}
                {viewMode === 'image' && <img src={imageData} className="w-full h-full object-contain" alt="Subject" />}
                {viewMode === 'voxel' && voxelCode && <iframe ref={iframeRef} srcDoc={voxelCode} className={`w-full h-full border-none voxel-cursor-${currentTool}`} sandbox="allow-scripts allow-same-origin" />}
              </div>
              <div className="flex gap-4">
                <button onClick={() => setViewMode(v => v === 'image' ? 'voxel' : 'image')} disabled={!voxelCode} className={`flex-1 py-4 border-4 border-black font-black uppercase shadow-[6px_6px_0px_0px_black] transition-all active:translate-y-1 active:shadow-none ${viewMode === 'voxel' ? 'bg-black text-white' : 'bg-white hover:bg-stone-100'}`}>Perspective Switch</button>
                <button onClick={handleTransmute} disabled={isLoading} className="flex-1 py-4 bg-yellow-300 border-4 border-black font-black uppercase shadow-[6px_6px_0px_0px_black] hover:bg-black hover:text-white transition-all active:translate-y-1 active:shadow-none">Transmute Artifact</button>
              </div>
            </div>

            <div className="md:col-span-4 space-y-6">
              <div className="bg-white border-4 border-black shadow-[8px_8px_0px_0px_black] overflow-hidden">
                <div className="flex border-b-4 border-black bg-stone-100">
                  {(['transform', 'atmosphere', 'physics', 'dashboard', 'export'] as InspectorTab[]).map(t => (
                    <button key={t} onClick={() => setActiveTab(t)} className={`flex-1 py-3 text-[9px] font-black uppercase tracking-widest transition-colors border-r-2 last:border-r-0 border-black ${activeTab === t ? 'bg-black text-white' : 'bg-white hover:bg-stone-50'}`}>{t}</button>
                  ))}
                </div>
                <div className="p-6 space-y-6 min-h-[300px]">
                  {activeTab === 'transform' && (
                    <div className="space-y-4 animate-in fade-in duration-300">
                      <label className="text-[10px] font-black uppercase text-stone-400">View Orientation</label>
                      <div className="grid grid-cols-2 gap-2">
                        {['isometric', 'top', 'front', 'side'].map(a => (
                          <button key={a} onClick={() => { if (voxelCode) {
                            const v = { isometric: {x:40, y:40, z:40}, top: {x:0.1, y:60, z:0}, front: {x:0, y:10, z:60}, side: {x:60, y:10, z:0} };
                            setVoxelCode(setCameraView(voxelCode, v[a as keyof typeof v]));
                          }}} className="py-2 border-2 border-black font-black text-[9px] uppercase hover:bg-black hover:text-white transition-all">Align {a}</button>
                        ))}
                      </div>
                      <button onClick={() => { setAutoRotate(!autoRotate); handlePatch({ autoRotate: !autoRotate }); }} className={`w-full py-3 border-2 border-black font-black uppercase text-[10px] transition-all ${autoRotate ? 'bg-black text-white' : 'bg-white hover:bg-stone-100'}`}>Orbit Sequence: {autoRotate ? 'RUNNING' : 'STOPPED'}</button>
                    </div>
                  )}
                  {activeTab === 'atmosphere' && (
                    <div className="space-y-6 animate-in fade-in duration-300">
                      <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase text-stone-400">Environment Preset</label>
                        <div className="grid grid-cols-3 gap-2">
                          {SKY_PRESETS.map(p => (
                             <button key={p.name} onClick={() => applySkyPreset(p.name)} className={`py-2 border-2 border-black font-black text-[8px] uppercase transition-all ${activeSky === p.name ? 'bg-yellow-300' : 'hover:bg-stone-50 bg-white'}`}>
                                {p.name}
                             </button>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase text-stone-400">Global Luminance</label>
                        <input type="range" min="0" max="3" step="0.1" value={lightIntensity} onChange={e => { setLightIntensity(Number(e.target.value)); handlePatch({ lightIntensity: Number(e.target.value) }); }} className="w-full accent-black cursor-pointer" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase text-stone-400">Atmospheric Density</label>
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
                    <div className="space-y-4 animate-in fade-in duration-300">
                      <div className="bg-yellow-50 p-3 border-2 border-black text-[9px] font-bold uppercase italic leading-tight">Kinematic Simulation enabled: Blocks respond to virtual gravity and collisions.</div>
                      <button onClick={() => togglePhysics(!physicsOn)} disabled={!voxelCode} className={`w-full py-4 border-2 border-black font-black uppercase text-xs shadow-[4px_4px_0px_0px_black] active:translate-y-1 active:shadow-none transition-all ${physicsOn ? 'bg-green-400' : 'bg-white hover:bg-stone-50'}`}>{physicsOn ? 'Simulation Active' : 'Engage Physics'}</button>
                      <button onClick={resetPhysics} disabled={!voxelCode} className="w-full py-2 border-2 border-black font-black uppercase text-[10px] hover:bg-red-500 hover:text-white transition-all bg-white">Reset Settlement</button>
                    </div>
                  )}
                  {activeTab === 'dashboard' && (
                    <div className="space-y-4 animate-in fade-in duration-300">
                      <label className="text-[10px] font-black uppercase text-stone-400">Scene Analytics</label>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="p-3 border-2 border-black bg-stone-50">
                          <span className="block text-[8px] font-bold text-stone-400 uppercase">Total Lattice</span>
                          <span className="text-xl font-black">{metrics.totalVoxels}</span>
                        </div>
                        <div className="p-3 border-2 border-black bg-stone-50">
                          <span className="block text-[8px] font-bold text-stone-400 uppercase">User Additions</span>
                          <span className="text-xl font-black">{metrics.userVoxels}</span>
                        </div>
                        <div className="p-3 border-2 border-black bg-stone-50">
                          <span className="block text-[8px] font-bold text-stone-400 uppercase">Unique Chroma</span>
                          <span className="text-xl font-black">{metrics.uniqueColors}</span>
                        </div>
                        <div className="p-3 border-2 border-black bg-stone-50">
                          <span className="block text-[8px] font-bold text-stone-400 uppercase">VRAM Usage</span>
                          <span className="text-xl font-black">{metrics.estimatedMemory}</span>
                        </div>
                      </div>
                      <div className="p-4 bg-stone-100 border-2 border-black text-[8px] font-bold uppercase tracking-tight">
                        Optimizing for WebGL 2.0. Ensure hardware acceleration is enabled for maximum performance.
                      </div>
                    </div>
                  )}
                  {activeTab === 'export' && (
                    <div className="space-y-6 animate-in fade-in duration-300">
                      <div className="space-y-4 border-b-2 border-stone-100 pb-4">
                        <div className="space-y-1">
                          <label className="text-[10px] font-black uppercase text-stone-400">Target Schema</label>
                          <select value={exportFormat} onChange={e => setExportFormat(e.target.value as ExportFormat)} className="w-full p-2 border-2 border-black font-black uppercase text-xs bg-white">
                            <option value="GLTF">GLTF Scene (Best Quality)</option>
                            <option value="OBJ">Wavefront OBJ (Mesh)</option>
                            <option value="VOX">MagicaVoxel Data</option>
                          </select>
                        </div>
                        <div className="space-y-2">
                           <div className="flex items-center gap-2">
                              <input type="checkbox" id="optimize" checked={optimizeExport} onChange={e => setOptimizeExport(e.target.checked)} className="w-4 h-4 accent-black" />
                              <label htmlFor="optimize" className="text-[10px] font-black uppercase cursor-pointer">Greedy Mesh Optimization</label>
                           </div>
                           <div className="flex items-center gap-2">
                              <input type="checkbox" id="atlas" checked={useTextureAtlas} onChange={e => setUseTextureAtlas(e.target.checked)} className="w-4 h-4 accent-black" />
                              <label htmlFor="atlas" className="text-[10px] font-black uppercase cursor-pointer">Bake Texture Atlas</label>
                           </div>
                           <div className="flex items-center gap-2">
                              <input type="checkbox" id="bakeAO" checked={bakeAO} onChange={e => setBakeAO(e.target.checked)} className="w-4 h-4 accent-black" />
                              <label htmlFor="bakeAO" className="text-[10px] font-black uppercase cursor-pointer">Simulate Ambient Occlusion</label>
                           </div>
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] font-black uppercase text-stone-400">Level of Detail (LOD)</label>
                          <select value={exportLOD} onChange={e => setExportLOD(e.target.value)} className="w-full p-2 border-2 border-black font-black uppercase text-xs bg-white">
                            <option value="High">Native Resolution</option>
                            <option value="Med">Balanced (2x Downsample)</option>
                            <option value="Low">Low Poly (4x Downsample)</option>
                          </select>
                        </div>
                      </div>
                      <button onClick={handleExport} disabled={!voxelCode || status === 'saving'} className="w-full py-4 bg-black text-white border-2 border-black font-black uppercase text-xs shadow-[6px_6px_0px_0px_rgba(0,0,0,0.3)] hover:bg-yellow-300 hover:text-black transition-all active:translate-y-1 active:shadow-none">Generate Pro Export</button>
                    </div>
                  )}
                </div>
                <div className="p-4 border-t-2 border-stone-100 bg-stone-50 flex gap-2">
                  <button onClick={handleUndo} disabled={!canUndo} className="flex-1 py-1 border-2 border-black text-[8px] font-black uppercase bg-white disabled:opacity-20 hover:bg-stone-100 transition-colors">Undo</button>
                  <button onClick={handleRedo} disabled={!canRedo} className="flex-1 py-1 border-2 border-black text-[8px] font-black uppercase bg-white disabled:opacity-20 hover:bg-stone-100 transition-colors">Redo</button>
                  <button onClick={handleSave} disabled={status === 'saving' || !imageData} className="flex-1 py-1 bg-yellow-300 border-2 border-black text-[8px] font-black uppercase shadow-[3px_3px_0px_0px_black] active:shadow-none transition-all disabled:opacity-30 hover:bg-yellow-400">Secure Entry</button>
                </div>
              </div>
              {errorMsg && <div className="p-4 bg-red-50 border-4 border-red-500 text-red-700 text-[10px] font-black uppercase tracking-tighter">Forge Fault: {errorMsg}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
