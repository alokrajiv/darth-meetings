"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { XIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
        className
      )}
      {...props}
    />
  )
}

/**
 * Focus goes back to whatever opened the dialog — for EVERY dialog in the app.
 *
 * Why this lives here and not in each dialog: Radix's modal content handler is
 *
 *   onCloseAutoFocus: composeEventHandlers(props.onCloseAutoFocus, (event) => {
 *     event.preventDefault();
 *     context.triggerRef.current?.focus();
 *   })
 *
 * (@radix-ui/react-dialog 1.1.15, dist/index.mjs:146). It `preventDefault()`s
 * unconditionally — which switches OFF FocusScope's own restore to the
 * previously focused element — and then focuses `triggerRef`, the node rendered
 * by `<DialogTrigger>`. Almost nothing in this app uses `DialogTrigger`: open
 * state is lifted (`open={x} onOpenChange={setX}`) and the opener is a plain
 * button, a table-row menu item or a `window` event. So `triggerRef.current` is
 * `null`, `null?.focus()` does nothing, and focus lands on `<body>` — the caret
 * at the top of a 4000-line page instead of on the link just pressed.
 *
 * The fix: remember who had focus when the dialog opened, and put it back
 * ourselves. Ours runs FIRST (it is `props.onCloseAutoFocus`), so calling
 * `preventDefault()` keeps Radix's null-focus from running at all. When there
 * is nowhere sensible to go — the opener was unmounted, or disabled by the very
 * action the dialog performed, or there was no opener (a `window` event) — we
 * do NOT preventDefault, and Radix's `DialogTrigger` path still gets its turn.
 */
function useOpenerFocus(
  onOpenAutoFocus: React.ComponentProps<typeof DialogPrimitive.Content>["onOpenAutoFocus"],
  onCloseAutoFocus: React.ComponentProps<typeof DialogPrimitive.Content>["onCloseAutoFocus"]
) {
  const openerRef = React.useRef<HTMLElement | null>(null)

  const handleOpenAutoFocus = React.useCallback(
    (event: Event) => {
      // Fires while the opener still holds focus, before the content takes it.
      const active = document.activeElement
      openerRef.current =
        active instanceof HTMLElement && active !== document.body ? active : null
      onOpenAutoFocus?.(event)
    },
    [onOpenAutoFocus]
  )

  const handleCloseAutoFocus = React.useCallback(
    (event: Event) => {
      onCloseAutoFocus?.(event)
      const opener = openerRef.current
      openerRef.current = null
      if (event.defaultPrevented) return // the dialog took focus somewhere itself
      if (!opener || !opener.isConnected) return
      // Focusing a disabled control silently drops focus to <body> — exactly
      // the bug. Leave it to Radix (and let the reader keep their own focus).
      if (
        opener.hasAttribute("disabled") ||
        opener.getAttribute("aria-disabled") === "true"
      ) {
        return
      }
      event.preventDefault()
      opener.focus()
    },
    [onCloseAutoFocus]
  )

  return { handleOpenAutoFocus, handleCloseAutoFocus }
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  const { handleOpenAutoFocus, handleCloseAutoFocus } = useOpenerFocus(
    onOpenAutoFocus,
    onCloseAutoFocus
  )
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        onOpenAutoFocus={handleOpenAutoFocus}
        onCloseAutoFocus={handleCloseAutoFocus}
        className={cn(
          "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
