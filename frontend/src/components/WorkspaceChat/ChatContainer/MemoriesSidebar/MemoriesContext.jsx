import { createContext, useContext, useState, useEffect } from "react";
import { useMemoriesSidebar } from "../ChatSidebar";
import useUser from "@/hooks/useUser";
import System from "@/models/system";
import Memory from "@/models/memory";

export const LIMITS = {
  personal: 20,
};

const MemoriesContext = createContext(null);

export function useMemoriesContext() {
  const ctx = useContext(MemoriesContext);
  if (!ctx) {
    throw new Error("useMemoriesContext must be used within MemoriesProvider");
  }
  return ctx;
}

export function MemoriesProvider({ children }) {
  const { sidebarOpen, closeSidebar } = useMemoriesSidebar();
  const { user } = useUser();
  const canToggle = user?.identity === "platform";

  const [memories, setMemories] = useState([]);
  const [modalState, setModalState] = useState({ open: false, mode: "create" });
  const [editingMemory, setEditingMemory] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [autoExtraction, setAutoExtraction] = useState(true);
  const [loadingEnabled, setLoadingEnabled] = useState(true);

  useEffect(() => {
    if (!sidebarOpen) return;
    System.keys().then((settings) => {
      setEnabled(!!settings?.MemoryEnabled);
      setAutoExtraction(settings?.MemoryAutoExtraction !== false);
      setLoadingEnabled(false);
    });
  }, [sidebarOpen]);

  async function fetchMemories() {
    const data = await Memory.forUser();
    setMemories(data);
  }

  useEffect(() => {
    if (sidebarOpen && enabled) fetchMemories();
  }, [sidebarOpen, enabled]);

  async function handleCreate(content) {
    const { memory } = await Memory.create({ content });
    if (memory) fetchMemories();
  }

  async function handleDelete(memoryId) {
    await Memory.delete(memoryId);
    fetchMemories();
  }

  async function handleUpdate(memoryId, content) {
    const { memory } = await Memory.update(memoryId, { content });
    if (memory) fetchMemories();
  }

  function openCreateModal() {
    setEditingMemory(null);
    setModalState({ open: true, mode: "create" });
  }

  function openEditModal(memory) {
    setEditingMemory(memory);
    setModalState({ open: true, mode: "edit" });
  }

  function closeModal() {
    setModalState({ open: false, mode: "create" });
    setEditingMemory(null);
  }

  const activeMemories = memories;

  const value = {
    sidebarOpen,
    closeSidebar,
    canToggle,
    memories,
    activeMemories,
    enabled,
    setEnabled,
    autoExtraction,
    setAutoExtraction,
    loadingEnabled,
    modalState,
    editingMemory,
    openCreateModal,
    openEditModal,
    closeModal,
    handleCreate,
    handleDelete,
    handleUpdate,
  };

  return (
    <MemoriesContext.Provider value={value}>
      {children}
    </MemoriesContext.Provider>
  );
}
