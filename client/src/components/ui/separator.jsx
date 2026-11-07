import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"

import { cn } from "@/lib/utils"

function Separator({
  className,
  orientation = "horizontal",
  ...props
}) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        // Forced colors repaint author fills as Canvas, which hid the rule; a
        // system color is kept.
        "shrink-0 bg-border forced-colors:bg-[color:CanvasText] data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
        className
      )}
      {...props} />
  );
}

export { Separator }
