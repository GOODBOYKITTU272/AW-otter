// GENERATED FILE — do not hand-edit.
// Regenerate with: supabase gen types typescript --local > packages/database/src/types.ts
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      audit_events: {
        Row: {
          action: string
          actor_id: string | null
          actor_type: string
          entity_id: string
          entity_type: string
          id: string
          metadata: Json
          occurred_at: string
          organization_id: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_type?: string
          entity_id: string
          entity_type: string
          id?: string
          metadata?: Json
          occurred_at?: string
          organization_id: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_type?: string
          entity_id?: string
          entity_type?: string
          id?: string
          metadata?: Json
          occurred_at?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_connection_secrets: {
        Row: {
          access_token_expires_at: string
          connection_id: string
          encrypted_access_token: string
          encrypted_refresh_token: string | null
          updated_at: string
        }
        Insert: {
          access_token_expires_at: string
          connection_id: string
          encrypted_access_token: string
          encrypted_refresh_token?: string | null
          updated_at?: string
        }
        Update: {
          access_token_expires_at?: string
          connection_id?: string
          encrypted_access_token?: string
          encrypted_refresh_token?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_connection_secrets_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: true
            referencedRelation: "calendar_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_connections: {
        Row: {
          created_at: string
          id: string
          last_reconciliation_result: Json | null
          last_sync_at: string | null
          organization_membership_id: string
          provider: string
          provider_user_id: string
          scope_metadata: Json
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_reconciliation_result?: Json | null
          last_sync_at?: string | null
          organization_membership_id: string
          provider?: string
          provider_user_id: string
          scope_metadata?: Json
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          last_reconciliation_result?: Json | null
          last_sync_at?: string | null
          organization_membership_id?: string
          provider?: string
          provider_user_id?: string
          scope_metadata?: Json
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_connections_organization_membership_id_fkey"
            columns: ["organization_membership_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_event_jobs: {
        Row: {
          attempts: number
          calendar_connection_id: string
          change_type: string
          created_at: string
          external_event_id: string
          id: string
          last_error: string | null
          organization_id: string
          provider: string
          provider_user_key: string
          run_at: string
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          calendar_connection_id: string
          change_type: string
          created_at?: string
          external_event_id: string
          id?: string
          last_error?: string | null
          organization_id: string
          provider?: string
          provider_user_key: string
          run_at?: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          calendar_connection_id?: string
          change_type?: string
          created_at?: string
          external_event_id?: string
          id?: string
          last_error?: string | null
          organization_id?: string
          provider?: string
          provider_user_key?: string
          run_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_event_jobs_calendar_connection_id_fkey"
            columns: ["calendar_connection_id"]
            isOneToOne: false
            referencedRelation: "calendar_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calendar_event_jobs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_sync_cursors: {
        Row: {
          calendar_connection_id: string
          cursor: string | null
          id: string
          updated_at: string
          window_end: string | null
          window_start: string | null
        }
        Insert: {
          calendar_connection_id: string
          cursor?: string | null
          id?: string
          updated_at?: string
          window_end?: string | null
          window_start?: string | null
        }
        Update: {
          calendar_connection_id?: string
          cursor?: string | null
          id?: string
          updated_at?: string
          window_end?: string | null
          window_start?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "calendar_sync_cursors_calendar_connection_id_fkey"
            columns: ["calendar_connection_id"]
            isOneToOne: false
            referencedRelation: "calendar_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          created_at: string
          id: string
          name: string
          organization_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          organization_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "departments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_attendees: {
        Row: {
          attended: boolean | null
          display_name: string | null
          email: string | null
          id: string
          invited: boolean | null
          joined_at: string | null
          left_at: string | null
          meeting_id: string
          participant_type: string | null
          provider_participant_id: string | null
        }
        Insert: {
          attended?: boolean | null
          display_name?: string | null
          email?: string | null
          id?: string
          invited?: boolean | null
          joined_at?: string | null
          left_at?: string | null
          meeting_id: string
          participant_type?: string | null
          provider_participant_id?: string | null
        }
        Update: {
          attended?: boolean | null
          display_name?: string | null
          email?: string | null
          id?: string
          invited?: boolean | null
          joined_at?: string | null
          left_at?: string | null
          meeting_id?: string
          participant_type?: string | null
          provider_participant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meeting_attendees_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_external_events: {
        Row: {
          external_event_id: string
          id: string
          is_organizer: boolean
          last_seen_at: string
          meeting_id: string
          organization_id: string
          provider: string
          provider_user_key: string
        }
        Insert: {
          external_event_id: string
          id?: string
          is_organizer?: boolean
          last_seen_at?: string
          meeting_id: string
          organization_id: string
          provider?: string
          provider_user_key: string
        }
        Update: {
          external_event_id?: string
          id?: string
          is_organizer?: boolean
          last_seen_at?: string
          meeting_id?: string
          organization_id?: string
          provider?: string
          provider_user_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "meeting_external_events_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meeting_external_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_policy_decisions: {
        Row: {
          context_snapshot: Json
          decision: Database["public"]["Enums"]["meeting_eligibility"]
          evaluated_at: string
          id: string
          meeting_id: string
          organization_id: string
          policy_set_id: string | null
          reason_code: string
          rule_type: string | null
        }
        Insert: {
          context_snapshot?: Json
          decision: Database["public"]["Enums"]["meeting_eligibility"]
          evaluated_at?: string
          id?: string
          meeting_id: string
          organization_id: string
          policy_set_id?: string | null
          reason_code: string
          rule_type?: string | null
        }
        Update: {
          context_snapshot?: Json
          decision?: Database["public"]["Enums"]["meeting_eligibility"]
          evaluated_at?: string
          id?: string
          meeting_id?: string
          organization_id?: string
          policy_set_id?: string | null
          reason_code?: string
          rule_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "meeting_policy_decisions_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meeting_policy_decisions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meeting_policy_decisions_policy_set_id_fkey"
            columns: ["policy_set_id"]
            isOneToOne: false
            referencedRelation: "meeting_policy_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_policy_rules: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          params: Json
          policy_set_id: string
          reason_code: string
          rule_type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          params?: Json
          policy_set_id: string
          reason_code: string
          rule_type: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          params?: Json
          policy_set_id?: string
          reason_code?: string
          rule_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meeting_policy_rules_policy_set_id_fkey"
            columns: ["policy_set_id"]
            isOneToOne: false
            referencedRelation: "meeting_policy_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_policy_sets: {
        Row: {
          created_at: string
          cutoff_minutes_before_start: number
          default_decision: Database["public"]["Enums"]["meeting_eligibility"]
          id: string
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          cutoff_minutes_before_start?: number
          default_decision?: Database["public"]["Enums"]["meeting_eligibility"]
          id?: string
          name?: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          cutoff_minutes_before_start?: number
          default_decision?: Database["public"]["Enums"]["meeting_eligibility"]
          id?: string
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meeting_policy_sets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      meetings: {
        Row: {
          actual_end: string | null
          actual_start: string | null
          created_at: string
          eligibility_status: Database["public"]["Enums"]["meeting_eligibility"]
          graph_event_type: string | null
          ical_uid: string
          id: string
          lifecycle_status: string
          meeting_type: string | null
          meeting_url: string | null
          organization_id: string
          organizer_email: string | null
          organizer_name: string | null
          original_start: string | null
          owner_membership_id: string | null
          provider: string
          reason_code: string | null
          scheduled_end: string
          scheduled_start: string
          series_master_id: string | null
          title: string
          updated_at: string
        }
        Insert: {
          actual_end?: string | null
          actual_start?: string | null
          created_at?: string
          eligibility_status?: Database["public"]["Enums"]["meeting_eligibility"]
          graph_event_type?: string | null
          ical_uid: string
          id?: string
          lifecycle_status?: string
          meeting_type?: string | null
          meeting_url?: string | null
          organization_id: string
          organizer_email?: string | null
          organizer_name?: string | null
          original_start?: string | null
          owner_membership_id?: string | null
          provider?: string
          reason_code?: string | null
          scheduled_end: string
          scheduled_start: string
          series_master_id?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          actual_end?: string | null
          actual_start?: string | null
          created_at?: string
          eligibility_status?: Database["public"]["Enums"]["meeting_eligibility"]
          graph_event_type?: string | null
          ical_uid?: string
          id?: string
          lifecycle_status?: string
          meeting_type?: string | null
          meeting_url?: string | null
          organization_id?: string
          organizer_email?: string | null
          organizer_name?: string | null
          original_start?: string | null
          owner_membership_id?: string | null
          provider?: string
          reason_code?: string | null
          scheduled_end?: string
          scheduled_start?: string
          series_master_id?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meetings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_owner_membership_id_fkey"
            columns: ["owner_membership_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["id"]
          },
        ]
      }
      microsoft_tenant_connections: {
        Row: {
          connected_at: string
          connected_by_membership_id: string | null
          id: string
          last_reconciliation_result: Json | null
          organization_id: string
          provider: string
          status: string
          updated_at: string
        }
        Insert: {
          connected_at?: string
          connected_by_membership_id?: string | null
          id?: string
          last_reconciliation_result?: Json | null
          organization_id: string
          provider?: string
          status?: string
          updated_at?: string
        }
        Update: {
          connected_at?: string
          connected_by_membership_id?: string | null
          id?: string
          last_reconciliation_result?: Json | null
          organization_id?: string
          provider?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "microsoft_tenant_connections_connected_by_membership_id_fkey"
            columns: ["connected_by_membership_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "microsoft_tenant_connections_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_memberships: {
        Row: {
          created_at: string
          deactivated_at: string | null
          department_id: string | null
          display_name: string
          id: string
          manager_membership_id: string | null
          meeting_ai_enabled: boolean
          organization_id: string
          role_id: string
          status: Database["public"]["Enums"]["membership_status"]
          team_id: string | null
          updated_at: string
          user_id: string | null
          work_email: string
        }
        Insert: {
          created_at?: string
          deactivated_at?: string | null
          department_id?: string | null
          display_name: string
          id?: string
          manager_membership_id?: string | null
          meeting_ai_enabled?: boolean
          organization_id: string
          role_id: string
          status?: Database["public"]["Enums"]["membership_status"]
          team_id?: string | null
          updated_at?: string
          user_id?: string | null
          work_email: string
        }
        Update: {
          created_at?: string
          deactivated_at?: string | null
          department_id?: string | null
          display_name?: string
          id?: string
          manager_membership_id?: string | null
          meeting_ai_enabled?: boolean
          organization_id?: string
          role_id?: string
          status?: Database["public"]["Enums"]["membership_status"]
          team_id?: string | null
          updated_at?: string
          user_id?: string | null
          work_email?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_memberships_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_memberships_manager_membership_id_fkey"
            columns: ["manager_membership_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_memberships_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_memberships_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_memberships_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          email_domain: string | null
          id: string
          name: string
          slug: string
          status: string
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email_domain?: string | null
          id?: string
          name: string
          slug: string
          status?: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email_domain?: string | null
          id?: string
          name?: string
          slug?: string
          status?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      permissions: {
        Row: {
          description: string
          key: string
        }
        Insert: {
          description: string
          key: string
        }
        Update: {
          description?: string
          key?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string
          email: string
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name: string
          email: string
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string
          email?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      provider_subscriptions: {
        Row: {
          calendar_connection_id: string
          created_at: string
          expires_at: string
          external_subscription_id: string
          id: string
          last_notification_at: string | null
          last_renewed_at: string | null
          provider: string
          resource: string
          status: string
          updated_at: string
        }
        Insert: {
          calendar_connection_id: string
          created_at?: string
          expires_at: string
          external_subscription_id: string
          id?: string
          last_notification_at?: string | null
          last_renewed_at?: string | null
          provider?: string
          resource: string
          status?: string
          updated_at?: string
        }
        Update: {
          calendar_connection_id?: string
          created_at?: string
          expires_at?: string
          external_subscription_id?: string
          id?: string
          last_notification_at?: string | null
          last_renewed_at?: string | null
          provider?: string
          resource?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_subscriptions_calendar_connection_id_fkey"
            columns: ["calendar_connection_id"]
            isOneToOne: false
            referencedRelation: "calendar_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      recording_exemption_requests: {
        Row: {
          created_at: string
          id: string
          meeting_id: string
          organization_id: string
          reason: string
          requested_at: string
          requested_by: string
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["exemption_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          meeting_id: string
          organization_id: string
          reason: string
          requested_at?: string
          requested_by: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["exemption_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          meeting_id?: string
          organization_id?: string
          reason?: string
          requested_at?: string
          requested_by?: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["exemption_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recording_exemption_requests_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recording_exemption_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recording_exemption_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recording_exemption_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["id"]
          },
        ]
      }
      role_permissions: {
        Row: {
          permission_key: string
          role_id: string
        }
        Insert: {
          permission_key: string
          role_id: string
        }
        Update: {
          permission_key?: string
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_key_fkey"
            columns: ["permission_key"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "role_permissions_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      roles: {
        Row: {
          created_at: string
          hierarchy_level: number
          id: string
          is_system_role: boolean
          key: string
          name: string
          organization_id: string | null
        }
        Insert: {
          created_at?: string
          hierarchy_level: number
          id?: string
          is_system_role?: boolean
          key: string
          name: string
          organization_id?: string | null
        }
        Update: {
          created_at?: string
          hierarchy_level?: number
          id?: string
          is_system_role?: boolean
          key?: string
          name?: string
          organization_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "roles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      teams: {
        Row: {
          created_at: string
          department_id: string | null
          id: string
          manager_membership_id: string | null
          name: string
          organization_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          department_id?: string | null
          id?: string
          manager_membership_id?: string | null
          name: string
          organization_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          department_id?: string | null
          id?: string
          manager_membership_id?: string | null
          name?: string
          organization_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "teams_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teams_manager_membership_id_fkey"
            columns: ["manager_membership_id"]
            isOneToOne: false
            referencedRelation: "organization_memberships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teams_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_next_calendar_event_job: {
        Args: never
        Returns: {
          attempts: number
          calendar_connection_id: string
          change_type: string
          created_at: string
          external_event_id: string
          id: string
          last_error: string | null
          organization_id: string
          provider: string
          provider_user_key: string
          run_at: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "calendar_event_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      exemption_status:
        | "requested"
        | "approved"
        | "rejected"
        | "cancelled"
        | "expired"
      meeting_eligibility:
        | "pending"
        | "record"
        | "exclude"
        | "pending_exception"
        | "unsupported"
      membership_status:
        | "invited"
        | "setup_required"
        | "active"
        | "suspended"
        | "deactivated"
      role_key: "admin" | "senior_manager" | "manager" | "account_manager"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      exemption_status: [
        "requested",
        "approved",
        "rejected",
        "cancelled",
        "expired",
      ],
      meeting_eligibility: [
        "pending",
        "record",
        "exclude",
        "pending_exception",
        "unsupported",
      ],
      membership_status: [
        "invited",
        "setup_required",
        "active",
        "suspended",
        "deactivated",
      ],
      role_key: ["admin", "senior_manager", "manager", "account_manager"],
    },
  },
} as const

