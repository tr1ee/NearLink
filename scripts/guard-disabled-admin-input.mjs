export const guardDisabledAdminInput = {
  name: "guard-disabled-admin-input",
  setup(build) {
    build.onLoad({ filter: /[/\\]windows-admin-input-[^/\\]+\.ts$/ }, () => ({
      errors: [
        {
          text: "Windows administrator input is disabled. Its policy, trust model and fixtures must stay out of production bundles until Windows acceptance passes.",
        },
      ],
    }));
  },
};
