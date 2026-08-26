CREATE TABLE IF NOT EXISTS `current_job` (
	`slot` integer PRIMARY KEY,
	`job_id` text NOT NULL,
	CONSTRAINT `fk_current_job_job_id_jobs_job_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`job_id`),
	CONSTRAINT "current_job_slot_check" CHECK("slot" = 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `database_metadata` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `job_records` (
	`job_id` text NOT NULL,
	`input_index` integer NOT NULL,
	`record_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`input_json` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`last_error_json` text,
	`leased_at` text,
	`started_at` text,
	`completed_at` text,
	`cache_validation_errors_json` text,
	`result_id` integer,
	CONSTRAINT `job_records_pk` PRIMARY KEY(`job_id`, `record_id`),
	CONSTRAINT `fk_job_records_job_id_jobs_job_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`job_id`),
	CONSTRAINT `fk_job_records_result_id_results_result_id_fk` FOREIGN KEY (`result_id`) REFERENCES `results`(`result_id`),
	CONSTRAINT "job_records_status_check" CHECK("status" IN (
        'pending', 'leased', 'running', 'completed',
        'skipped_valid', 'skipped_invalid', 'failed'
      ))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `jobs` (
	`job_id` text PRIMARY KEY,
	`state_version` integer NOT NULL,
	`session_status` text NOT NULL,
	`superseded_at` text,
	`superseded_by_job_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`input_data` text NOT NULL,
	`task_spec` text NOT NULL,
	`output_dir` text NOT NULL,
	`id_column_key` text NOT NULL,
	`records_path` text,
	`source_hash` text NOT NULL,
	`task_hash` text NOT NULL,
	`execution_hash` text NOT NULL,
	`spec_json` text NOT NULL,
	`settings_json` text NOT NULL,
	`cache_diagnostics_json` text NOT NULL,
	CONSTRAINT "jobs_session_status_check" CHECK("session_status" IN ('active', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `results` (
	`result_id` integer PRIMARY KEY AUTOINCREMENT,
	`record_id` text NOT NULL,
	`input_hash` text NOT NULL,
	`execution_hash` text NOT NULL,
	`output_json` text NOT NULL,
	`output_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `job_records_order_unique` ON `job_records` (`job_id`,`input_index`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `job_records_lease_unique` ON `job_records` (`lease_token`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `job_records_queue_index` ON `job_records` (`job_id`,`status`,`input_index`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `results_lookup_index` ON `results` (`record_id`,`input_hash`,`execution_hash`);
