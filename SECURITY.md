# Security policy

## Supported versions

Only the latest release in the Portikus apt repository gets security fixes.
Upgrade with `sudo apt update && sudo apt upgrade` before reporting, and
check your version with `dpkg -s portikus` or the About page.

## Reporting a vulnerability

Please report privately. Do not open a public issue.

Use GitHub private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**.

Include:

- the Portikus version;
- what an attacker can do, and who the attacker is (a student, an
  instructor, someone not signed in, or code running in a workspace);
- the steps to reproduce it, or a proof of concept;
- any logs or screenshots, with secrets removed.

## What to expect

- We aim to acknowledge a report within a week.
- We will tell you whether we accept it, and keep you updated while we fix it.
- We publish the fix in the apt repository with a GitHub security advisory,
  and credit you unless you ask us not to.

Please give us a reasonable time to ship a fix before you disclose it.
