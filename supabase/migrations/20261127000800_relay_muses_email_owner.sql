-- Add optional owner email metadata to relay_muses (used by Dashboard AddMuseWizard & AgentsAdminView)
alter table public.relay_muses add column if not exists email_owner text;
