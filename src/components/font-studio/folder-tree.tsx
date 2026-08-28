import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { ChevronRight, Eye, Folder, FolderPlus, FolderSearch, Layers, Pencil, Power, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { filesFromDataTransfer } from "@/lib/fonts/fs-drop";
import {
  collectionIsWatched,
  folderDeleteImpact,
  folderFontStats,
  folderTree,
  useFontStore,
} from "@/lib/fonts/store";
import { ActivateMenuItem, DeactivateMenuItem } from "./activate-toggle";
import { HelpTip } from "./help-tip";
import { runFontImport } from "./import-fonts";
import { addWatchedFolder } from "@/lib/fonts/watch-folder";
import { SidebarCount, SidebarOverflowMenu, sidebarMainClass } from "./sidebar-row";
import type { Collection } from "@/lib/fonts/types";
import { cn } from "@/lib/utils";

const FONT_DRAG = "application/x-font-id";
const FOLDER_DRAG = "application/x-folder-id";
const EMPTY_IDS: string[] = [];

export function LibraryGroups({ onNewCollection }: { onNewCollection: () => void }) {
  return (
    <>
      <GroupTree kind="collection" onNew={onNewCollection} />
      <GroupTree kind="folder" onNew={() => void addWatchedFolder()} />
    </>
  );
}

/** @deprecated use LibraryGroups */
export const FolderTree = LibraryGroups;

function GroupTree({
  kind,
  onNew,
}: {
  kind: "collection" | "folder";
  onNew: () => void;
}) {
  const collections = useFontStore((s) => s.collections);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [overId, setOverId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Collection | null>(null);
  const isFolder = kind === "folder";

  const rows = useMemo(() => {
    return folderTree(collections).filter(({ folder }) => collectionIsWatched(collections, folder.id) === isFolder);
  }, [collections, isFolder]);

  const childIds = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) {
      const parent = row.folder.parentId;
      if (parent && rows.some((r) => r.folder.id === parent)) set.add(parent);
    }
    return set;
  }, [rows]);

  const stats = useMemo(() => folderFontStats(collections), [collections]);
  const byId = useMemo(() => {
    const map = new Map<string, Collection>();
    for (const c of collections) map.set(c.id, c);
    return map;
  }, [collections]);

  const visible = useMemo(() => {
    return rows.filter((row) => {
      let parent = row.folder.parentId;
      while (parent) {
        if (collapsed[parent]) return false;
        parent = byId.get(parent)?.parentId ?? null;
      }
      return true;
    });
  }, [rows, collapsed, byId]);

  const pendingImpact = useMemo(() => {
    if (!pendingDelete) return null;
    const { collections: cols, localFonts } = useFontStore.getState();
    return folderDeleteImpact(cols, localFonts, pendingDelete.id);
  }, [pendingDelete]);

  const onToggle = useCallback((id: string) => {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);
  const onStartRename = useCallback((id: string) => setRenamingId(id), []);
  const onCancelRename = useCallback(() => setRenamingId(null), []);
  const onNewSubfolder = useCallback((parentId: string) => {
    const label = isFolder ? "Untitled subfolder" : "Untitled collection";
    const id = useFontStore.getState().addCollection(label, parentId);
    setCollapsed((prev) => ({ ...prev, [parentId]: false }));
    setRenamingId(id);
  }, [isFolder]);
  const onDelete = useCallback((folder: Collection) => setPendingDelete(folder), []);
  const onDragOver = useCallback((id: string, e: DragEvent) => {
    e.preventDefault();
    setOverId(id);
  }, []);
  const onDragLeave = useCallback((id: string) => {
    setOverId((current) => (current === id ? null : current));
  }, []);
  const onDrop = useCallback((targetId: string, e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOverId(null);
    const types = Array.from(e.dataTransfer.types);
    if (types.includes("Files")) {
      void filesFromDataTransfer(e.dataTransfer).then(({ files }) => {
        if (files.length) void runFontImport(files, { collectionId: targetId });
      });
      return;
    }
    const fontId = e.dataTransfer.getData(FONT_DRAG);
    if (fontId.startsWith("g:") || fontId.startsWith("l:")) {
      useFontStore.getState().addToCollection(targetId, fontId);
      return;
    }
    const plain = e.dataTransfer.getData("text/plain");
    const movedId =
      e.dataTransfer.getData(FOLDER_DRAG) || (plain.startsWith("folder:") ? plain.slice(7) : "");
    if (!movedId || movedId === targetId) return;
    const cols = useFontStore.getState().collections;
    if (collectionIsWatched(cols, movedId) !== collectionIsWatched(cols, targetId)) {
      toast.message("Keep collections and folders separate", {
        description: "Collections are virtual groups. Folders are real disks we watch.",
      });
      return;
    }
    useFontStore.getState().moveCollection(movedId, targetId);
  }, []);

  function confirmDelete() {
    if (!pendingDelete) return;
    const name = pendingDelete.name;
    const result = useFontStore.getState().deleteCollection(pendingDelete.id);
    setPendingDelete(null);
    if (result.fonts) {
      toast.success(
        `Removed ${name} and ${result.fonts.toLocaleString()} typeface${result.fonts === 1 ? "" : "s"} from the library`,
      );
    } else {
      toast.success(`Removed ${name}`);
    }
  }

  const noun = isFolder ? "folder" : "collection";

  return (
    <section>
      <div className="mb-0.5 flex h-8 w-full min-w-0 items-center pl-2.5 pr-2.5">
        <p className="min-w-0 flex-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {isFolder ? "Folders" : "Collections"}
        </p>
        <HelpTip
          label={
            isFolder
              ? "Watch a disk folder — files stay put, new fonts appear here"
              : "New collection — virtual group, files are not moved"
          }
        >
          <button
            type="button"
            aria-label={isFolder ? "Watch folder" : "New collection"}
            onClick={onNew}
            className="flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
          >
            {isFolder ? <FolderSearch className="size-3.5" /> : <FolderPlus className="size-3.5" />}
          </button>
        </HelpTip>
      </div>
      {rows.length === 0 && (
        <p className="px-2.5 pb-1 text-xs text-muted-foreground">
          {isFolder
            ? "No watched folders. Files stay on disk."
            : "No collections. Virtual groups only."}
        </p>
      )}
      {visible.map(({ folder, depth }) => {
        const stat = stats.get(folder.id);
        return (
          <GroupRow
            key={folder.id}
            folder={folder}
            kind={kind}
            depth={depth}
            hasChildren={childIds.has(folder.id)}
            expanded={!collapsed[folder.id]}
            renaming={renamingId === folder.id}
            dropTarget={overId === folder.id}
            count={stat?.count ?? 0}
            fontIds={stat?.ids ?? EMPTY_IDS}
            onToggle={onToggle}
            onStartRename={onStartRename}
            onCancelRename={onCancelRename}
            onNewSubfolder={onNewSubfolder}
            onDelete={onDelete}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          />
        );
      })}

      <Dialog open={Boolean(pendingDelete)} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {pendingDelete?.name ?? noun}?</DialogTitle>
            <DialogDescription>
              {isFolder
                ? "Stops watching this disk folder. Files on disk are never deleted."
                : pendingImpact && pendingImpact.localFontIds.length > 0
                  ? `Removes this collection${pendingImpact.folderIds.length > 1 ? " and nested collections" : ""} from the sidebar. Uploads stay in the library unless they only lived here.`
                  : "Only this collection is removed from the sidebar."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmDelete}>
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

const GroupRow = memo(function GroupRow({
  folder,
  kind,
  depth,
  hasChildren,
  expanded,
  renaming,
  dropTarget,
  count,
  fontIds,
  onToggle,
  onStartRename,
  onCancelRename,
  onNewSubfolder,
  onDelete,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  folder: Collection;
  kind: "collection" | "folder";
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  renaming: boolean;
  dropTarget: boolean;
  count: number;
  fontIds: string[];
  onToggle: (id: string) => void;
  onStartRename: (id: string) => void;
  onCancelRename: () => void;
  onNewSubfolder: (parentId: string) => void;
  onDelete: (folder: Collection) => void;
  onDragOver: (id: string, e: DragEvent) => void;
  onDragLeave: (id: string) => void;
  onDrop: (id: string, e: DragEvent) => void;
}) {
  const active = useFontStore((s) => s.scope === `collection:${folder.id}`);
  const [draft, setDraft] = useState(folder.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const skipBlur = useRef(false);
  const isFolder = kind === "folder";

  useEffect(() => {
    if (renaming) setDraft(folder.name);
  }, [renaming, folder.name]);

  const indent = depth ? { marginLeft: depth * 12 } : undefined;
  const Icon = isFolder ? Folder : Layers;

  return (
    <div
      className={cn("group relative flex w-full min-w-0 items-center", dropTarget && "bg-accent")}
      onDragOver={(e) => onDragOver(folder.id, e)}
      onDragLeave={() => onDragLeave(folder.id)}
      onDrop={(e) => onDrop(folder.id, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenuOpen(true);
      }}
    >
      {renaming ? (
        <Input
          autoFocus
          value={draft}
          aria-label={isFolder ? "Folder name" : "Collection name"}
          className="h-8 flex-1 px-2.5 text-sm"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (skipBlur.current) {
              skipBlur.current = false;
              return;
            }
            useFontStore.getState().renameCollection(folder.id, draft);
            onCancelRename();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              skipBlur.current = true;
              setDraft(folder.name);
              onCancelRename();
            }
          }}
        />
      ) : (
        <button
          type="button"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(FOLDER_DRAG, folder.id);
            e.dataTransfer.setData("text/plain", `folder:${folder.id}`);
            e.dataTransfer.effectAllowed = "move";
          }}
          onClick={() => useFontStore.getState().setScope(`collection:${folder.id}`)}
          onDoubleClick={() => onStartRename(folder.id)}
          aria-label={`${isFolder ? "Folder" : "Collection"} ${folder.name}`}
          className={sidebarMainClass(active)}
        >
          <span className="relative flex size-4 shrink-0 items-center justify-center" style={indent}>
            <Icon
              className={cn(
                "size-4",
                hasChildren && "transition-opacity duration-150 group-hover:opacity-0",
              )}
            />
          </span>
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
          {folder.watchPath ? <Eye className="size-3 shrink-0 text-muted-foreground" aria-hidden /> : null}
          <SidebarCount value={count} fadeOnHover hidden={menuOpen} />
        </button>
      )}
      {hasChildren && !renaming && (
        <button
          type="button"
          aria-label={expanded ? "Collapse" : "Expand"}
          className="pointer-events-none absolute top-1/2 z-10 flex size-4 -translate-y-1/2 items-center justify-center text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100"
          style={{ left: 10 + depth * 12 }}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(folder.id);
          }}
        >
          <ChevronRight className={cn("size-3 transition-transform duration-150", expanded && "rotate-90")} />
        </button>
      )}
      {!renaming && (
        <SidebarOverflowMenu label={folder.name} open={menuOpen} onOpenChange={setMenuOpen}>
          {hasChildren && (
            <DropdownMenuItem onSelect={() => onToggle(folder.id)}>
              <ChevronRight className={cn("size-3.5", expanded && "rotate-90")} />
              {expanded ? "Collapse" : "Expand"}
            </DropdownMenuItem>
          )}
          <ActivateMenuItem ids={fontIds} label={folder.name} />
          <DeactivateMenuItem ids={fontIds} label={folder.name} />
          {folder.watchPath ? (
            <>
              <DropdownMenuItem
                onSelect={() => {
                  const on = !folder.autoActivate;
                  useFontStore.getState().setCollectionAutoActivate(folder.id, on);
                  if (on && fontIds.length) useFontStore.getState().setActivatedMany(fontIds, true);
                  toast.success(on ? "Auto-activate on" : "Auto-activate off", {
                    description: on
                      ? "New files in this folder activate for other apps."
                      : "New files are listed only. Activate them yourself.",
                  });
                }}
              >
                <Power className="size-3.5" />
                {folder.autoActivate ? "Auto-activate on" : "Auto-activate off"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  useFontStore.getState().setCollectionWatch(folder.id, undefined, false);
                  toast.message("Moved to Collections", {
                    description: "Stopped watching the disk. Files were never copied.",
                  });
                }}
              >
                <Layers className="size-3.5" />
                Convert to collection
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuItem onSelect={() => onStartRename(folder.id)}>
            <Pencil className="size-3.5" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onNewSubfolder(folder.id)}>
            {isFolder ? <FolderPlus className="size-3.5" /> : <Layers className="size-3.5" />}
            {isFolder ? "New subfolder" : "New collection"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onDelete(folder)} className="text-destructive">
            <Trash2 className="size-3.5" />
            {isFolder ? "Stop watching" : "Delete"}
          </DropdownMenuItem>
        </SidebarOverflowMenu>
      )}
    </div>
  );
});
