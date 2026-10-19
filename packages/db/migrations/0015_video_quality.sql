-- Live-view picture quality per browser: the sharpest level the viewer uses, and whether it adapts
-- to the connection below that level (on by default).
ALTER TABLE browser_instances ADD COLUMN video_quality TEXT NOT NULL DEFAULT 'full' CHECK (video_quality IN ('full', 'high', 'medium', 'low'));
--> statement-breakpoint
ALTER TABLE browser_instances ADD COLUMN video_auto INTEGER NOT NULL DEFAULT 1;
