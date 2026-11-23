# Bhuleshwar company server support

The connector runs under the Windows user who paired it on the Tally server. Enable verified team access, link the Tally company and financial year, and designate the installation as that company's server in Tally Connector. The two database migrations dated 20261123 and 20261124 are prerequisites for the routing and support endpoints.

Install the first support-enabled build on the server. After pairing, quit the idle tray application and run the installed resources/powershell/set-server-startup.ps1 as the paired user. Disconnecting Remote Desktop leaves that user's session running. After reboot or sign-out, the user must log on and open the intended company. The cloud can report the last heartbeat during an outage.

Grant **Diagnose the company connector and look up vouchers** on the Purchases role for the intended company. Voucher lookup also requires purchase-view permission. The Support panel records the initiating user and job status. To investigate reconciliation, use the selected company's GST books refresh for the requested month. For an uncertain purchase, use Verify existing on the original case to request read-back against the frozen approval.

An all-company connection administrator can check the configured release feed and request installation of an exact staged version. The Windows connector requires valid Authenticode signatures on its own executable and the staged installer, with the same signer thumbprint. Start with a signed connector before relying on unattended updates. Signing certificate rotation requires a separately trusted bootstrap. The support history shows version confirmation after a subsequent heartbeat.

The offline installer and migrations are independent release artifacts. Publishing the web/API and signing or publishing a Windows release are separate deployment steps.
