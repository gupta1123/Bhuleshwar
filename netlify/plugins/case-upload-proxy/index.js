module.exports = {
  onPreBuild({ netlifyConfig, utils }) {
    const target = [process.env.API_PROXY_TARGET, process.env.NEXT_PUBLIC_API_BASE_URL]
      .map(value => value?.trim().replace(/\/+$/, "").replace(/\/api$/, ""))
      .find(Boolean);
    if (!target) {
      return utils.build.failBuild("Set API_PROXY_TARGET or NEXT_PUBLIC_API_BASE_URL for case uploads.");
    }

    const uploadRoutes = ["/api/cases", "/api/cases/:caseId/files"];
    netlifyConfig.redirects = [
      ...uploadRoutes.map(from => ({ from, to: target + from, status: 200, force: true })),
      ...(netlifyConfig.redirects || []),
    ];
  },
};
