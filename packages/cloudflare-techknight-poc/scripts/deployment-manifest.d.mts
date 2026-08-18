export interface CustomerManagedDeploymentManifest {
  schema_version: "1.0";
  deployment_profile: "customer_managed_oss";
  runtime: {
    target: "cloudflare-workers-compatible";
    config: string;
    entrypoint: string;
    output: string;
  };
  contract: {
    protocol_id: string;
    version_range: string;
    required_capabilities: string[];
  };
  required_bindings: {
    services: ["BRAINBASE_TENANT_RUNTIME_SERVICE", "SLACK_INSTALLATION_CONTROL_PLANE"];
    durable_objects: [{
      binding: "TENANT_RUNTIME_STATE";
      class_name: "TenantRuntimeState";
      migration_required: true;
    }];
  };
  oauth: {
    required_vars: [
      "SLACK_OAUTH_APP_ID",
      "SLACK_OAUTH_CLIENT_ID",
      "SLACK_OAUTH_REDIRECT_URI",
      "SLACK_OAUTH_SCOPES",
    ];
    state: {
      durable_object_binding: "TENANT_RUNTIME_STATE";
      durable_object_class: "TenantRuntimeState";
      migration_required: true;
    };
  };
  credential_modes: string[];
  secrets: {
    required_names: string[];
    values_included: false;
  };
  required_customer_configuration: string[];
  optional_capabilities: Record<string, string>;
}
