## Important Notice

When building a newly updated program, make sure to:

1. Update the program version [according to SemVer](https://semver.org/).
2. Remove `skyline_program_prev.so`.
3. Rename `skyline_program_latest.so` to `skyline_program_prev.so`.
4. Generate a new `skyline_program.so`.
5. Rename the new `skyline_program.so` to `skyline_program_latest.so`.
6. Run `Test_SkylineSolana_UpgradeAndUpdates` to verify that upgradeability works.