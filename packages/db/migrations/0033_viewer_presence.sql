-- Visibility reports are ordered per viewer session. Existing clients retain input-only behavior.
ALTER TABLE viewer_sessions ADD COLUMN presence_seq integer NOT NULL DEFAULT -1;
--> statement-breakpoint
ALTER TABLE viewer_sessions ADD COLUMN viewing integer;
--> statement-breakpoint
ALTER TABLE viewer_sessions ADD COLUMN presence_at integer;
