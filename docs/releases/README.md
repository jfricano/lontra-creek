# Lontra Creek site release plans

This directory owns changes to Lontra Creek's public site and demo: pages, visitor journeys, synthetic scenarios, session isolation, demo API integration, operating limits, hosting, and site acceptance/launch gates.

- [V1.1 site and demo plan](v1.1/README.md): Source failures in the existing Failure Lab and the actual workbench sandbox replacing the existing `/workbench/` page.
- [Site plan](../PLAN.md): overall experience and operating rules.
- [Deployment plan](../DEPLOYMENT_PLAN.md) and [shared-host readiness](../SHARED_HOST_READINESS.md): engineering/deployment records, separate from planned features.

StreamOtter's package-library specification and native acceptance plans are maintained in the StreamOtter repository, under `docs/releases/`. Lontra Creek consumes exact published npm packages and does not implement or copy the library's failure engine. Site release versions and deployment decisions remain independent of library publication.
