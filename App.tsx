
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/


import React, { useState, useRef, useEffect, useCallback } from 'react';
import { generateImage, generateVoxelScene, IMAGE_SYSTEM_PROMPT, VOXEL_PROMPT } from './services/gemini';
import { extractHtmlFromText, hideBodyText, zoomCamera, injectSubtleAnimation, applySceneBackground } from './utils/html';

type AppStatus = 'idle' | 'generating_image' | 'generating_voxels' | 'error';

interface UserContent {
  image: string;
  voxel: string | null;
  prompt: string;
  palette: string[];
  backgroundColor: string;
}

interface SavedScene extends UserContent {
  id: string;
  timestamp: number;
}

// Available aspect ratios
const ASPECT_RATIOS = ["1:1", "3:4", "4:3", "16:9", "9:16"];

// Allowed file types
const ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif'
];

const SAMPLE_PROMPTS = [
    "A tree house under the sea",
    "A cyberpunk street food stall", 
    "An ancient temple floating in the sky",
    "A cozy winter cabin with smoke",
    "A futuristic mars rover",
    "A dragon guarding gold"
];

const STORAGE_KEY = 'voxel_art_gallery_v1';

interface Example {
  img: string;
  html: string;
}

const EXAMPLES: Example[] = [
  { img: 'https://www.gstatic.com/aistudio/starter-apps/image_to_voxel/example1.png', html: '/examples/example1.html' },
  { img: 'https://www.gstatic.com/aistudio/starter-apps/image_to_voxel/example2.png', html: '/examples/example2.html' },
  { img: 'https://www.gstatic.com/aistudio/starter-apps/image_to_voxel/example3.png', html: '/examples/example3.html' },
];

const App: React.FC = () => {
  const [prompt, setPrompt] = useState('');
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  
  // Main View State
  const [imageData, setImageData] = useState<string | null>(null);
  const [voxelCode, setVoxelCode] = useState<string | null>(null);
  const [palette, setPalette] = useState<string[]>(['#FF0000', '#00FF00', '#0000FF']);
  const [sceneBgColor, setSceneBgColor] = useState('#ffffff');
  
  // User Content History
  const [history, setHistory] = useState<UserContent[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // User Content Persistence
  const [userContent, setUserContent] = useState<UserContent | null>(null);

  // Gallery State
  const [savedScenes, setSavedScenes] = useState<SavedScene[]>([]);

  // Navigation State
  const [selectedTile, setSelectedTile] = useState<number | 'user' | string | null>(null);
  const [showGenerator, setShowGenerator] = useState(false);
  const [showRoadmap, setShowRoadmap] = useState(false);

  const [status, setStatus] = useState<AppStatus>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [useOptimization, setUseOptimization] = useState(true);
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [viewMode, setViewMode] = useState<'image' | 'voxel'>('image');
  
  // Streaming Thoughts State
  const [thinkingText, setThinkingText] = useState<string | null>(null);
  
  const [loadedThumbnails, setLoadedThumbnails] = useState<Record<string, string>>({});

  // New UI States
  const [isDragging, setIsDragging] = useState(false);
  const [isViewerVisible, setIsViewerVisible] = useState(true);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load Gallery from LocalStorage
  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        setSavedScenes(parsed);
      } catch (e) {
        console.error("Failed to parse gallery", e);
      }
    }
  }, []);

  // Sync Gallery to LocalStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedScenes));
  }, [savedScenes]);

  // Rotate placeholders
  useEffect(() => {
    const interval = setInterval(() => {
        setPlaceholderIndex((prev) => (prev + 1) % SAMPLE_PROMPTS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  // Load thumbnails
  useEffect(() => {
    const createdUrls: string[] = [];
    const loadThumbnails = async () => {
      const loaded: Record<string, string> = {};
      await Promise.all(EXAMPLES.map(async (ex) => {
        try {
          const response = await fetch(ex.img);
          if (response.ok) {
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            createdUrls.push(url);
            loaded[ex.img] = url;
          }
        } catch (e) {
          console.error("Failed to load thumbnail:", ex.img, e);
        }
      }));
      setLoadedThumbnails(loaded);
    };
    loadThumbnails();
    return () => {
        createdUrls.forEach(url => URL.revokeObjectURL(url));
    };
  }, []);

  // Update current state from history
  useEffect(() => {
    if (historyIndex >= 0 && historyIndex < history.length && selectedTile === 'user') {
      const state = history[historyIndex];
      setImageData(state.image);
      setVoxelCode(state.voxel);
      setPrompt(state.prompt);
      setPalette(state.palette);
      setSceneBgColor(state.backgroundColor || '#ffffff');
      setUserContent(state);
    }
  }, [historyIndex, history, selectedTile]);

  const pushToHistory = useCallback((newState: UserContent) => {
    setHistory(prev => {
      const newHistory = prev.slice(0, historyIndex + 1);
      newHistory.push(newState);
      if (newHistory.length > 20) newHistory.shift();
      return newHistory;
    });
    setHistoryIndex(prev => {
      const newIdx = prev + 1;
      return newIdx >= 20 ? 19 : newIdx;
    });
  }, [historyIndex]);

  const handleUndo = () => {
    if (historyIndex > 0) {
      setHistoryIndex(historyIndex - 1);
      setViewMode('image');
    }
  };

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      setHistoryIndex(historyIndex + 1);
      setViewMode('image');
    }
  };

  const handleError = (err: any) => {
    setStatus('error');
    setErrorMsg(err.message || 'An unexpected error occurred.');
    console.error(err);
  };

  const handleImageGenerate = async () => {
    if (!prompt.trim()) return;
    setStatus('generating_image');
    setErrorMsg('');
    setImageData(null);
    setVoxelCode(null);
    setThinkingText(null);
    setViewMode('image');
    setIsViewerVisible(true);

    try {
      const imageUrl = await generateImage(prompt, aspectRatio, useOptimization);
      const newUserContent = {
          image: imageUrl,
          voxel: null,
          prompt: prompt,
          palette: [...palette],
          backgroundColor: sceneBgColor
      };
      pushToHistory(newUserContent);
      setSelectedTile('user');
      setStatus('idle');
      setShowGenerator(false);
    } catch (err) {
      handleError(err);
    }
  };

  const processFile = (file: File) => {
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      handleError(new Error("Invalid file type. Please upload PNG, JPEG, WEBP, HEIC, or HEIF."));
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      const newUserContent = {
          image: result,
          voxel: null,
          prompt: '',
          palette: [...palette],
          backgroundColor: sceneBgColor
      };
      pushToHistory(newUserContent);
      setImageData(result);
      setVoxelCode(null);
      setViewMode('image');
      setStatus('idle');
      setErrorMsg('');
      setSelectedTile('user');
      setShowGenerator(false);
      setIsViewerVisible(true);
    };
    reader.onerror = () => handleError(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) processFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  const handleExampleClick = async (example: Example, index: number) => {
    if (status !== 'idle' && status !== 'error') return;
    setSelectedTile(index);
    setShowGenerator(false);
    setErrorMsg('');
    setThinkingText(null);
    setIsViewerVisible(true);
    
    try {
      const imgResponse = await fetch(example.img);
      if (!imgResponse.ok) throw new Error(`Failed to load example image: ${imgResponse.statusText}`);
      const imgBlob = await imgResponse.blob();
      const base64Img = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(imgBlob);
      });

      let htmlText = '';
      try {
        const htmlResponse = await fetch(example.html);
        if (htmlResponse.ok) {
            const rawText = await htmlResponse.text();
            // Process, add animations, and apply default background
            htmlText = applySceneBackground(injectSubtleAnimation(zoomCamera(hideBodyText(extractHtmlFromText(rawText)))), '#ffffff');
        } else {
            htmlText = `<html><body><p>${example.html} not found.</p></body></html>`;
        }
      } catch (e) {
          htmlText = "<html><body>Error loading example scene.</body></html>";
      }

      setImageData(base64Img);
      setVoxelCode(htmlText);
      setViewMode('voxel');
      setStatus('idle');
    } catch (err) {
      handleError(err);
    }
  };

  const handleUserTileClick = () => {
      if (status !== 'idle' && status !== 'error') return;
      if (selectedTile === 'user') {
          const willShow = !showGenerator;
          setShowGenerator(willShow);
          if (willShow) setIsViewerVisible(false);
          else {
            setIsViewerVisible(true);
            if (!userContent) setSelectedTile(null);
          }
      } else {
          setSelectedTile('user');
          setShowGenerator(true); 
          setIsViewerVisible(false);
          if (userContent) {
              setImageData(userContent.image);
              setVoxelCode(userContent.voxel);
              setPrompt(userContent.prompt);
              setPalette(userContent.palette || ['#FF0000', '#00FF00', '#0000FF']);
              setSceneBgColor(userContent.backgroundColor || '#ffffff');
              setViewMode(userContent.voxel ? 'voxel' : 'image');
          } else {
              setImageData(null);
              setVoxelCode(null);
              setViewMode('image');
          }
      }
  };

  const handleSavedTileClick = (scene: SavedScene) => {
    if (status !== 'idle' && status !== 'error') return;
    setSelectedTile(scene.id);
    setShowGenerator(false);
    setErrorMsg('');
    setThinkingText(null);
    setIsViewerVisible(true);

    setImageData(scene.image);
    setVoxelCode(scene.voxel);
    setPrompt(scene.prompt);
    setPalette(scene.palette);
    setSceneBgColor(scene.backgroundColor || '#ffffff');
    setViewMode(scene.voxel ? 'voxel' : 'image');
  };

  const handleVoxelize = async () => {
    if (!imageData) return;
    setStatus('generating_voxels');
    setErrorMsg('');
    setThinkingText(null);
    setIsViewerVisible(true);
    let thoughtBuffer = "";

    try {
      const codeRaw = await generateVoxelScene(imageData, (thoughtFragment) => {
          thoughtBuffer += thoughtFragment;
          const matches = thoughtBuffer.match(/\*\*([^*]+)\*\*/g);
          if (matches && matches.length > 0) {
              const lastMatch = matches[matches.length - 1];
              const header = lastMatch.replace(/\*\*/g, '').trim();
              setThinkingText(prev => prev === header ? prev : header);
          }
      }, palette);
      
      // Process, add ambient animation, and apply background
      const code = applySceneBackground(injectSubtleAnimation(zoomCamera(hideBodyText(codeRaw))), sceneBgColor);
      setVoxelCode(code);
      
      if (selectedTile === 'user') {
          const updated = {
            image: imageData,
            voxel: code,
            prompt: prompt,
            palette: [...palette],
            backgroundColor: sceneBgColor
          };
          pushToHistory(updated);
      }
      setViewMode('voxel');
      setStatus('idle');
      setThinkingText(null);
    } catch (err) {
      handleError(err);
    }
  };

  const handleSaveToGallery = () => {
    if (!imageData) return;
    
    const newScene: SavedScene = {
      id: `scene_${Date.now()}`,
      timestamp: Date.now(),
      image: imageData,
      voxel: voxelCode,
      prompt: prompt,
      palette: [...palette],
      backgroundColor: sceneBgColor
    };

    setSavedScenes(prev => [newScene, ...prev]);
  };

  const handleDeleteSaved = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setSavedScenes(prev => prev.filter(s => s.id !== id));
    if (selectedTile === id) {
      setSelectedTile(null);
      setImageData(null);
      setVoxelCode(null);
    }
  };

  const handleDownload = () => {
    if (viewMode === 'image' && imageData) {
      const a = document.createElement('a');
      a.href = imageData;
      const ext = imageData.includes('image/jpeg') ? 'jpg' : 'png';
      a.download = `voxelize-image-${Date.now()}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } else if (viewMode === 'voxel' && voxelCode) {
      const a = document.createElement('a');
      a.href = `data:text/html;charset=utf-8,${encodeURIComponent(voxelCode)}`;
      a.download = `voxel-scene-${Date.now()}.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  const updatePaletteColor = (index: number, color: string) => {
      const newPalette = [...palette];
      newPalette[index] = color;
      setPalette(newPalette);
  };

  const updateSceneBg = (color: string) => {
      setSceneBgColor(color);
      // If we already have voxel code, we can hot-patch it for immediate feedback
      if (voxelCode) {
          const updatedCode = applySceneBackground(voxelCode, color);
          setVoxelCode(updatedCode);
          
          if (selectedTile === 'user' && imageData) {
              pushToHistory({
                image: imageData,
                voxel: updatedCode,
                prompt: prompt,
                palette: [...palette],
                backgroundColor: color
              });
          }
      }
  };

  const savePaletteChange = () => {
      if (selectedTile === 'user' && imageData) {
          pushToHistory({
            image: imageData,
            voxel: voxelCode,
            prompt: prompt,
            palette: [...palette],
            backgroundColor: sceneBgColor
          });
      }
  };

  const addPaletteColor = () => {
      const newPalette = [...palette, '#cccccc'];
      setPalette(newPalette);
      savePaletteChange();
  };

  const removePaletteColor = (index: number) => {
      if (palette.length <= 1) return;
      const newPalette = palette.filter((_, i) => i !== index);
      setPalette(newPalette);
      savePaletteChange();
  };

  const isLoading = status !== 'idle' && status !== 'error';

  const getDisplayPrompt = () => {
    if (status === 'generating_image') {
      return useOptimization ? `${IMAGE_SYSTEM_PROMPT}\n\nSubject: ${prompt}` : prompt;
    }
    if (status === 'generating_voxels') {
      return VOXEL_PROMPT;
    }
    return '';
  };

  return (
    <div className="min-h-screen flex flex-col items-center py-12 px-4 sm:px-6 lg:px-8 font-sans bg-white relative">
      <style>
        {`
          .loading-dots::after {
            content: '';
            animation: dots 2s steps(4, end) infinite;
          }
          @keyframes dots {
            0%, 20% { content: ''; }
            40% { content: '.'; }
            60% { content: '..'; }
            80% { content: '...'; }
          }
          .custom-color-input {
              -webkit-appearance: none;
              border: none;
              width: 100%;
              height: 100%;
              cursor: pointer;
              background: none;
          }
          .custom-color-input::-webkit-color-swatch-wrapper {
              padding: 0;
          }
          .custom-color-input::-webkit-color-swatch {
              border: none;
          }
        `}
      </style>

      {showRoadmap && (
        <div className="fixed inset-0 z-50 bg-white p-6 sm:p-12 overflow-y-auto animate-in fade-in slide-in-from-bottom-10 duration-300">
           <div className="max-w-3xl mx-auto space-y-12">
              <div className="flex justify-between items-start border-b-4 border-black pb-6">
                <div>
                  <h2 className="text-4xl sm:text-6xl font-black uppercase leading-none tracking-tighter">PROJECT ROADMAP</h2>
                  <p className="mt-2 text-lg font-bold text-gray-500 uppercase">The future of Voxel Art Generation</p>
                </div>
                <button 
                  onClick={() => setShowRoadmap(false)}
                  className="p-2 border-2 border-black hover:bg-black hover:text-white transition-colors shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] active:translate-y-1 active:shadow-none"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="grid gap-12">
                  <section className="space-y-4">
                    <h3 className="text-2xl font-black uppercase flex items-center gap-3">
                      <span className="bg-yellow-300 px-3 py-1 border-2 border-black shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]">PHASE 1</span>
                      Precision Control
                    </h3>
                    <div className="grid gap-4">
                      <div className="border-2 border-black p-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] bg-green-100">
                        <span className="text-xs font-bold bg-green-400 border border-black px-2 py-0.5 uppercase mb-2 inline-block">LIVE</span>
                        <h4 className="font-bold text-xl uppercase">Manual Palette Overrides</h4>
                        <p className="text-gray-600 text-sm">Fine-tune the colors generated by Gemini before voxelizing the scene.</p>
                      </div>
                      <div className="border-2 border-black p-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] bg-green-100">
                        <span className="text-xs font-bold bg-green-400 border border-black px-2 py-0.5 uppercase mb-2 inline-block">LIVE</span>
                        <h4 className="font-bold text-xl uppercase">Ambient Animations</h4>
                        <p className="text-gray-600 text-sm">Every scene now features gentle floating and entrance effects.</p>
                      </div>
                      <div className="border-2 border-black p-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] bg-green-100">
                        <span className="text-xs font-bold bg-green-400 border border-black px-2 py-0.5 uppercase mb-2 inline-block">LIVE</span>
                        <h4 className="font-bold text-xl uppercase">Undo / Redo System</h4>
                        <p className="text-gray-600 text-sm">Step through your creative history with full state recovery.</p>
                      </div>
                      <div className="border-2 border-black p-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] bg-green-100">
                        <span className="text-xs font-bold bg-green-400 border border-black px-2 py-0.5 uppercase mb-2 inline-block">LIVE</span>
                        <h4 className="font-bold text-xl uppercase">Local Gallery</h4>
                        <p className="text-gray-600 text-sm">Save your favorite scenes to your browser's local storage.</p>
                      </div>
                      <div className="border-2 border-black p-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] bg-green-50">
                        <span className="text-xs font-bold bg-green-400 border border-black px-2 py-0.5 uppercase mb-2 inline-block">NEW</span>
                        <h4 className="font-bold text-xl uppercase">Scene Background Control</h4>
                        <p className="text-gray-600 text-sm">Customize the world background color with real-time updates.</p>
                      </div>
                    </div>
                  </section>
              </div>

              <div className="pt-12 text-center border-t-2 border-gray-200">
                <button 
                  onClick={() => setShowRoadmap(false)}
                  className="bg-black text-white px-8 py-4 font-black uppercase text-xl shadow-[6px_6px_0px_0px_rgba(0,0,0,0.4)] hover:-translate-y-1 hover:shadow-[10px_10px_0px_0px_rgba(0,0,0,0.4)] active:translate-y-0 transition-all"
                >
                  BACK TO THE LAB
                </button>
              </div>
           </div>
        </div>
      )}

      <div className="w-full max-w-2xl space-y-8">
        
        <div className="border-b-2 border-black pb-6 relative">
          <div className="flex justify-between items-start mb-4">
            <h1 className="text-4xl sm:text-5xl font-black leading-[0.9] tracking-tight">IMAGE TO VOXEL ART</h1>
            <button 
              onClick={() => setShowRoadmap(true)}
              className="px-3 py-1 border-2 border-black text-xs font-black uppercase shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] hover:bg-yellow-300 transition-colors"
            >
              Roadmap
            </button>
          </div>
          <p className="text-lg text-gray-600 font-semibold">Create voxel art scenes inspired by any image, with Gemini 3.</p>
        </div>

        <div className="space-y-4">
            <div className="flex justify-between items-end border-b border-gray-200 pb-1">
                <h2 className="text-xs font-black uppercase tracking-widest text-gray-400">Library & Creation</h2>
            </div>
            <div className="grid grid-cols-4 gap-4 w-full">
                {EXAMPLES.map((ex, idx) => (
                    <button
                        key={idx}
                        type="button"
                        onClick={() => handleExampleClick(ex, idx)}
                        disabled={isLoading}
                        className={`aspect-square relative overflow-hidden group focus:outline-none disabled:opacity-50 cursor-pointer bg-gray-100 transition-all duration-200 border-2 border-black
                            ${selectedTile === idx ? 'scale-[1.02] shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] -translate-y-1' : 'hover:border-gray-600 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-1 hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]'}
                        `}
                    >
                        {loadedThumbnails[ex.img] ? (
                            <img src={loadedThumbnails[ex.img]} alt="" className="w-full h-full object-cover" />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center bg-gray-200 text-xs uppercase font-bold animate-pulse">Loading</div>
                        )}
                        {selectedTile !== idx && <div className="absolute inset-0 bg-white bg-opacity-40 group-hover:bg-opacity-0 transition-all"></div>}
                    </button>
                ))}
                
                <button
                    type="button"
                    onClick={handleUserTileClick}
                    disabled={isLoading}
                    className={`aspect-square flex flex-col items-center justify-center transition-all duration-200 focus:outline-none disabled:opacity-50 group overflow-hidden relative border-2 border-black
                        ${selectedTile === 'user' ? 'scale-[1.02] -translate-y-1' : 'hover:border-gray-600 hover:-translate-y-1 hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]'}
                        ${!userContent && !showGenerator ? 'bg-white text-black hover:bg-gray-50 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]' : 'bg-white'}
                        ${showGenerator && selectedTile === 'user' ? 'bg-black text-white shadow-[4px_4px_0px_0px_#888]' : (selectedTile === 'user' ? 'shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]' : 'shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]')}
                    `}
                >
                    {userContent ? (
                        <>
                            <img src={userContent.image} alt="" className="w-full h-full object-cover" />
                            {selectedTile !== 'user' && (
                                <div className="absolute inset-0 bg-black bg-opacity-30 flex items-center justify-center group-hover:bg-opacity-50 transition-all">
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor" className="w-12 h-12 text-white"><path strokeLinecap="square" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                                </div>
                            )}
                            {selectedTile === 'user' && showGenerator && (
                                <div className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center">
                                    <span className="text-white font-bold uppercase text-sm">Editing</span>
                                </div>
                            )}
                        </>
                    ) : (
                        <>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className={`w-10 h-10 transition-transform ${showGenerator ? 'rotate-45' : 'group-hover:scale-110'}`}><path strokeLinecap="square" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                            <span className="text-xs font-bold uppercase mt-2">{showGenerator ? 'Close' : 'Generate'}</span>
                        </>
                    )}
                </button>
            </div>

            {savedScenes.length > 0 && (
                <div className="space-y-4 animate-in fade-in slide-in-from-left-4 duration-500">
                    <div className="flex justify-between items-end border-b border-gray-200 pb-1">
                        <h2 className="text-xs font-black uppercase tracking-widest text-gray-400">My Gallery</h2>
                    </div>
                    <div className="grid grid-cols-4 gap-4 w-full">
                        {savedScenes.map((scene) => (
                            <button
                                key={scene.id}
                                type="button"
                                onClick={() => handleSavedTileClick(scene)}
                                disabled={isLoading}
                                className={`aspect-square relative overflow-hidden group focus:outline-none disabled:opacity-50 cursor-pointer bg-gray-100 transition-all duration-200 border-2 border-black
                                    ${selectedTile === scene.id ? 'scale-[1.02] shadow-[6px_6px_0px_0px_rgba(0,0,0,1)] -translate-y-1' : 'hover:border-gray-600 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:-translate-y-1 hover:shadow-[6px_6px_0px_0px_rgba(0,0,0,1)]'}
                                `}
                            >
                                <img src={scene.image} alt="" className="w-full h-full object-cover" />
                                {selectedTile !== scene.id && <div className="absolute inset-0 bg-white bg-opacity-40 group-hover:bg-opacity-0 transition-all"></div>}
                                
                                <button 
                                    onClick={(e) => handleDeleteSaved(e, scene.id)}
                                    className="absolute top-1 right-1 bg-black text-white w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-[10px] font-bold border border-white"
                                    title="Delete from Gallery"
                                >
                                    ✕
                                </button>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>

        {showGenerator && (
            <div className="space-y-6 animate-in slide-in-from-top-4 fade-in duration-300 border-2 border-black p-6 bg-gray-50 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] relative z-10">
            <div className="w-full">
                <label className="block text-sm font-bold mb-2 uppercase">Upload Image</label>
                <div onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop} onClick={() => fileInputRef.current?.click()}
                    className={`w-full h-64 border-2 border-dashed border-black flex flex-col items-center justify-center cursor-pointer transition-colors ${isDragging ? 'bg-gray-200' : 'bg-white hover:bg-gray-50'}`}>
                    <input type="file" accept={ALLOWED_MIME_TYPES.join(',')} ref={fileInputRef} onChange={handleFileUpload} className="hidden" />
                    <p className="font-bold uppercase text-sm text-gray-600">Drag and drop or click to upload</p>
                </div>
            </div>
            <div className="relative flex items-center justify-center w-full"><div className="border-t-2 border-gray-200 w-full absolute"></div><span className="bg-gray-50 px-3 text-xs font-bold text-gray-400 uppercase relative z-10">OR</span></div>
            <div className="flex flex-col md:flex-row gap-4 items-end">
                <div className="flex-grow w-full">
                <label htmlFor="prompt" className="block text-sm font-bold mb-2 uppercase">Generate Image</label>
                <input id="prompt" type="text" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={SAMPLE_PROMPTS[placeholderIndex]} className="w-full px-3 border-2 border-black focus:outline-none rounded-none text-lg bg-white h-12" disabled={isLoading} />
                </div>
                <div className="w-full sm:w-40">
                    <label htmlFor="aspect" className="block text-sm font-bold mb-2 uppercase">Aspect ratio</label>
                    <select id="aspect" value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)} disabled={isLoading} className="w-full px-3 border-2 border-black focus:outline-none rounded-none bg-white h-12">
                        {ASPECT_RATIOS.map(ratio => (<option key={ratio} value={ratio}>{ratio}</option>))}
                    </select>
                </div>
            </div>
            <div className="flex justify-end items-center gap-6 mt-2">
                <label className="flex items-center cursor-pointer select-none">
                    <div className="relative">
                    <input type="checkbox" className="sr-only" checked={useOptimization} onChange={(e) => setUseOptimization(e.target.checked)} disabled={isLoading} />
                    <div className={`block w-10 h-6 border-2 border-black ${useOptimization ? 'bg-black' : 'bg-gray-500'}`}></div>
                    <div className={`dot absolute left-1 top-1 bg-white w-4 h-4 transition-transform ${useOptimization ? 'translate-x-4' : ''}`}></div>
                    </div>
                    <div className="ml-3 text-sm font-bold uppercase">Optimise Scene</div>
                </label>
                <button type="button" onClick={handleImageGenerate} disabled={isLoading || !prompt.trim()} className="w-full sm:w-40 h-12 bg-black text-white border-2 border-black font-bold uppercase hover:bg-gray-900 disabled:opacity-50 transition-all shadow-[4px_4px_0px_0px_rgba(0,0,0,0.5)] text-sm">
                    {status === 'generating_image' ? 'Generating...' : 'Generate'}
                </button>
            </div>
            </div>
        )}

        {errorMsg && <div className="p-4 border-2 border-red-500 bg-red-50 text-red-700 text-sm font-bold">ERROR: {errorMsg}</div>}

        {imageData && !isLoading && (
            <div className="space-y-6 animate-in slide-in-from-top-2 fade-in duration-300 border-2 border-black p-6 bg-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
                <div className="flex justify-between items-center border-b-2 border-black pb-2">
                    <h3 className="font-black uppercase text-lg">Scene Controls</h3>
                    <div className="flex gap-2">
                        <button onClick={handleUndo} disabled={historyIndex <= 0} className="px-2 py-1 border border-black text-[10px] font-black uppercase disabled:opacity-30 hover:bg-gray-100">Undo</button>
                        <button onClick={handleRedo} disabled={historyIndex >= history.length - 1} className="px-2 py-1 border border-black text-[10px] font-black uppercase disabled:opacity-30 hover:bg-gray-100">Redo</button>
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                    {/* Palette Editor */}
                    <div className="space-y-3">
                        <label className="block text-[10px] font-black uppercase text-gray-400">Voxel Palette Overrides</label>
                        <div className="flex flex-wrap gap-2">
                            {palette.map((color, idx) => (
                                <div key={idx} className="relative group w-10 h-10">
                                    <div className="w-full h-full border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] overflow-hidden">
                                        <input type="color" value={color} onChange={(e) => updatePaletteColor(idx, e.target.value)} onBlur={savePaletteChange} className="custom-color-input" />
                                    </div>
                                    <button onClick={() => removePaletteColor(idx)} className="absolute -top-2 -right-2 bg-black text-white w-4 h-4 flex items-center justify-center border border-white text-[8px] opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
                                </div>
                            ))}
                            <button onClick={addPaletteColor} className="w-10 h-10 border-2 border-dashed border-black flex items-center justify-center hover:bg-gray-100 transition-colors shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">+</button>
                        </div>
                    </div>

                    {/* Scene Background Color */}
                    <div className="space-y-3">
                        <label className="block text-[10px] font-black uppercase text-gray-400">Scene Background Color</label>
                        <div className="flex items-center gap-3">
                             <div className="w-10 h-10 border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] overflow-hidden">
                                <input 
                                    type="color" 
                                    value={sceneBgColor} 
                                    onChange={(e) => updateSceneBg(e.target.value)} 
                                    className="custom-color-input" 
                                />
                             </div>
                             <span className="text-xs font-mono font-bold uppercase">{sceneBgColor}</span>
                        </div>
                    </div>
                </div>

                <p className="text-[10px] font-mono text-gray-400 uppercase border-t border-gray-100 pt-2">Note: Background changes apply in real-time to active scenes.</p>
            </div>
        )}

        <div className="space-y-2">
            {isViewerVisible && (
            <div className="w-full aspect-square border-2 border-black relative bg-gray-50 flex items-center justify-center overflow-hidden shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
            {isLoading && (
                <div className="absolute inset-0 bg-white z-20 flex flex-col items-start justify-center p-8 overflow-hidden">
                    <div className="w-full max-w-3xl mb-10 text-xl font-bold tracking-tight">{status === 'generating_image' ? 'Generating with Gemini 2.5 Flash Image' : 'Building scene with Gemini 3 Pro'}</div>
                    <div className="w-full max-w-3xl mb-8 opacity-70 font-mono text-xs border-l-2 border-gray-300 pl-4 max-h-[40%] overflow-y-auto">
                        {status === 'generating_voxels' && imageData && <img src={imageData} alt="" className="inline-block h-[1.5em] w-auto mr-2 align-middle border border-gray-300" />}
                        <span className="align-middle">{getDisplayPrompt()}</span>
                    </div>
                    <div className="w-full max-w-3xl opacity-70 font-mono text-xs max-h-[40%] overflow-y-auto">
                        {thinkingText ? <span>{thinkingText}<span className="loading-dots"></span></span> : <span className="loading-dots">Thinking</span>}
                    </div>
                </div>
            )}
            {!imageData && !isLoading && status !== 'error' && <div className="text-gray-400 text-center px-6"><p className="text-lg">Select an example or generate your own!</p></div>}
            {imageData && viewMode === 'image' && <img src={imageData} alt="" className="w-full h-full object-contain" />}
            {voxelCode && viewMode === 'voxel' && <iframe title="Voxel Scene" srcDoc={voxelCode} className="w-full h-full border-0" sandbox="allow-scripts allow-same-origin allow-popups" />}
            </div>
            )}

            {isViewerVisible && (
            <div className="flex flex-wrap gap-4 pt-4">
            {imageData && voxelCode && (
                <button type="button" onClick={() => setViewMode(viewMode === 'image' ? 'voxel' : 'image')} disabled={isLoading} className="flex-1 min-w-[140px] py-4 border-2 border-black bg-white font-bold uppercase transition-all shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-gray-50 hover:-translate-y-1">
                {viewMode === 'image' ? 'View Scene' : 'View Image'}
                </button>
            )}
            {((viewMode === 'image' && imageData) || (viewMode === 'voxel' && voxelCode)) && (
                <button type="button" onClick={handleDownload} disabled={isLoading} className="flex-1 min-w-[140px] py-4 border-2 border-black bg-white font-bold uppercase transition-all shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-gray-50 hover:-translate-y-1">
                Download {viewMode === 'image' ? 'Image' : 'HTML'}
                </button>
            )}
            {imageData && (
                <div className="flex flex-1 gap-4">
                    <button type="button" onClick={handleVoxelize} disabled={isLoading} className="flex-grow min-w-[160px] py-4 bg-black text-white border-2 border-black font-bold uppercase transition-all shadow-[4px_4px_0px_0px_rgba(0,0,0,0.5)] hover:bg-gray-900 hover:-translate-y-1">
                    {voxelCode ? 'Regenerate' : 'Voxelize'}
                    </button>
                    <button 
                        type="button" 
                        onClick={handleSaveToGallery} 
                        disabled={isLoading}
                        className="w-16 py-4 border-2 border-black bg-white flex items-center justify-center shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-yellow-100 transition-all hover:-translate-y-1 active:translate-y-0 active:shadow-none"
                        title="Save to My Gallery"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" /></svg>
                    </button>
                </div>
            )}
            </div>
            )}
        </div>
      </div>
    </div>
  );
};

export default App;
