"use client";

import * as React from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface SearchableOption {
  value: string;
  label: string;
  hint?: string | null;
}

export interface SearchableSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SearchableOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  invalid?: boolean;
  allowClear?: boolean;
  className?: string;
  "aria-label"?: string;
}

const MAX_VISIBLE = 150;

// Styled like SelectDropdown, with type-to-filter for long Tally master lists.
export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyMessage = "No matches.",
  disabled = false,
  invalid = false,
  allowClear = true,
  className = "",
  "aria-label": ariaLabel,
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();

  const selected = options.find((option) => option.value === value);
  const filtered = React.useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return options;
    return options.filter((option) => {
      const haystack = `${option.label} ${option.hint ?? ""}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [options, query]);
  const visible = filtered.slice(0, MAX_VISIBLE);

  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    const index = options.findIndex((option) => option.value === value);
    setActive(index >= 0 && index < MAX_VISIBLE ? index : 0);
  }, [open, options, value]);

  React.useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function choose(next: string) {
    onChange(next);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, visible.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (visible[active]) choose(visible[active].value);
    }
  }

  return (
    <Popover open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
      <PopoverTrigger asChild>
        <button
          aria-controls={listId}
          aria-expanded={open}
          aria-label={ariaLabel}
          className={cn(
            "flex h-9 w-full items-center justify-between gap-2 rounded-lg border bg-[#fbfaf8] px-3 text-xs font-medium shadow-sm transition-all hover:border-[#b9aa99] hover:bg-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#b9aa99] disabled:cursor-not-allowed disabled:opacity-50",
            invalid ? "border-amber-300 bg-amber-50/60" : "border-[#ded8d0]",
            className
          )}
          disabled={disabled}
          role="combobox"
          type="button"
        >
          <span className={cn("min-w-0 truncate text-left", value ? "text-[#111827]" : "text-[#a89e92]")}>
            {selected?.label ?? (value || placeholder)}
          </span>
          <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-[#8a7f72] transition-transform duration-200", open && "rotate-180 text-[#3d3530]")} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="z-50 w-[max(var(--radix-popover-trigger-width),320px)] rounded-lg border border-[#e0d8cc] bg-white p-0 text-xs text-[#111827] shadow-lg outline-none"
        sideOffset={4}
      >
        <div className="flex items-center gap-2 border-b border-[#f0ece4] px-3">
          <Search className="h-3.5 w-3.5 shrink-0 text-[#8a7f72]" />
          <input
            autoFocus
            className="h-9 w-full bg-transparent text-xs text-[#111827] outline-none placeholder:text-[#a89e92]"
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            placeholder={searchPlaceholder}
            value={query}
          />
          {query ? (
            <button aria-label="Clear search" className="rounded p-0.5 text-[#8a7f72] hover:text-[#111827]" onClick={() => setQuery("")} type="button">
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        <div className="max-h-72 overflow-y-auto p-1" id={listId} ref={listRef} role="listbox">
          {visible.map((option, index) => {
            const isSelected = option.value === value;
            return (
              <div
                aria-selected={isSelected}
                className={cn(
                  "flex cursor-pointer select-none items-center justify-between gap-3 rounded-md px-2.5 py-1.5 transition-colors",
                  index === active ? "bg-[#f5efe6] text-[#111827]" : "text-[#3d3530]",
                  isSelected && "font-semibold"
                )}
                data-index={index}
                key={option.value}
                onClick={() => choose(option.value)}
                onMouseMove={() => setActive(index)}
                role="option"
              >
                <span className="min-w-0">
                  <span className="block truncate">{option.label}</span>
                  {option.hint ? <span className="block truncate text-[11px] font-normal text-[#8a7f72]">{option.hint}</span> : null}
                </span>
                {isSelected ? <Check className="h-3.5 w-3.5 shrink-0 text-[#2b1a10]" /> : null}
              </div>
            );
          })}
          {visible.length === 0 ? <div className="px-2.5 py-6 text-center text-[#8a7f72]">{emptyMessage}</div> : null}
          {filtered.length > MAX_VISIBLE ? (
            <div className="px-2.5 py-1.5 text-[11px] text-[#8a7f72]">Showing {MAX_VISIBLE} of {filtered.length}. Type to narrow down.</div>
          ) : null}
        </div>
        {allowClear && value ? (
          <button className="w-full border-t border-[#f0ece4] px-3 py-2 text-left text-[11px] font-medium text-[#8a7f72] hover:bg-[#fbfaf8] hover:text-[#b91c1c]" onClick={() => choose("")} type="button">
            Clear selection
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
