# Wildcat Protocol Master Loan Agreement — template, with an illustrative Term Sheet

Source: the Wildcat Protocol template MLA published at https://docs.wildcat.finance/legal/master-loan-agreement, which Wildcat describes as an optional open-source template borrowers can attach to a market. The template fields (`{{...}}` in the original) are filled below with **illustrative** values for a fictional borrower, "Demo MM Ltd". No real borrower, lender, market or wallet is described. This file exists so the compiler has a source document whose clauses can be quoted verbatim and hashed. Not legal advice.

***

## WILDCAT PROTOCOL MASTER LOAN AGREEMENT

This Master Loan Agreement (this `Agreement`) is made on this 2026-09-26 by and between Demo MM Ltd (the `Borrower`), a Cayman Islands exempted company with registered address at 1 Illustrative Way, George Town, Grand Cayman and the individual or entity that has ownership of the Specified Wallet Address provided in Exhibit A hereto (the `Lender`). Lender and Borrower are individually, a `Party`, and collectively the `Parties`.

### RECITALS

WHEREAS, subject to the terms and conditions of this Agreement, the Borrower wishes to utilise a Market via the Protocol, pursuant to which the Borrower wishes to borrow the Assets from the Lender, and the Borrower will pay the Base APR and/or Penalty APR, as applicable, and return such Assets to the Market for Withdrawal by the Lender upon the termination of the Loan; and

NOW, THEREFORE, in consideration of the foregoing and other good and valuable consideration, the receipt and sufficiency of which hereby acknowledged, the Borrower and the Lender hereby agree as follows:

### 1) Definitions

`Amount of Digital Asset To Be Loaned` means the capacity of the Market, being the amount of Assets the Borrower is willing to borrow and pay the Base APR and/or Penalty APR on.

`Applicable Law` means any law (including common law), constitution, statute or statutory instrument, treaty, directive, rule (including, for the avoidance of doubt, the FCA Handbook), regulation, ordinance, order, injunction, writ, decree or award of any regulatory body.

`Assets` means any assets that the Borrower may attempt to borrow from a Lender as specified in the Market.

`Base APR` means the interest rate that the Lender will receive on the Assets that they have deposited into the Market, in the absence of the Penalty APR being enforced.

`Business Day` means a day other than a Saturday or Sunday and upon which banks are typically open for business in London, United Kingdom.

`Chain ID` means the unique number identifying a particular EVM blockchain network.

`Chainalysis Sanctions Screening Oracle` means a smart contract that can be queried to determine whether a particular Wallet Address is included in a sanctions designation, as defined at https://go.chainalysis.com/chainalysis-oracle-docs.html.

`Communication Platform` means digital communication platforms such as electronic mail, Telegram, Slack, X or other similar platforms, as specified by the Borrower on the Website.

`Delinquent` means, with respect to the Market, any period of time in which there are insufficient Assets in the Market to meet the Reserve Ratio specified by the Borrower in the Term Sheet, which may be as a result of (a) the amount of Assets held within a Market falling below the Reserve Ratio as a result of Market Token Supply growth resulting from the Base APR and/or the Penalty APR and/or the removal from the Market of any accrued Protocol Fees, (b) the Reserve Ratio increasing as a result of Withdrawal requests that cannot be completed given the amount of Equivalent Loan Assets in the Market or (c) the Reserve Ratio temporarily increasing as a result of a reduction of the Base APR, each as may be further explained in the Wildcat Protocol Documentation.

`Deposit Credential` means, with respect to a Market, permission – either temporary or permanent, as configured by the Borrower – to deposit Assets into a Market granted by a Role Provider according to a Lender Check Process determined by the Borrower.

`Equivalent` means, with respect to Loaned Assets, Assets equivalent to those Loaned Assets, as determined by the Borrower in its sole reasonable discretion or as mutually agreed between the Parties in writing.

`Fixed Term State` means the optional Borrower-configured period of time after the deployment of a Market during which Withdrawals from Lenders are rejected.

`Grace Period` means the period of time for which a Market can be Delinquent on a rolling basis before the Penalty APR becomes payable.

`Known Lender` means, with respect to a Market, a state assigned to any Wallet Address that – while holding a valid, unexpired Deposit Credential – either (i) enters into a Loan by depositing Assets into the Market, or (ii) receives Market Tokens from a third party Wallet Address provided that the Market supports sufficient Token Transferability.

`Lender Check Process` means any process of due diligence, anti-money laundering and/or `know your customer` screening which the Borrower has chosen to implement to determine the suitability of a Lender to enter into a Loan via this Market under this Agreement.

`Loan` means the loan of Assets made pursuant to and in accordance with the Market, this Agreement and the Term Sheet.

`Loan Documents` means this Agreement and any and all Loan Term Sheets entered into between the Lender and the Borrower.

`Loaned Assets` means any Assets transferred in a Loan hereunder until an Equivalent Asset to such Asset is transferred to Lender hereunder.

`Loss` means damage, loss, cost, claim, liability, obligation or expense (including legal costs and expenses of any kind), of any kind whatsoever under any theory of liability, including direct, indirect, consequential, incidental or special losses, economic losses or loss of profits, loss of data, loss of goodwill or business reputation, loss of opportunity, cost of obtaining substitute tokens, or other tangible and intangible loss.

`Market` means the market that the Borrower has deployed.

`Market Token` means the token issued by the Market to the Lender in exchange for their Loan, the Amount of which increases over time in accordance with the currently active Base APR and/or Penalty APR of a Market as set forth in the Wildcat Protocol Documentation, and which represents the amount of the Loaned Asset which a Lender is eligible to reclaim via Withdrawal.

`Market Token Supply` means the balance of Market Tokens issued across all Loans made using the Market central to this Agreement.

`Open Term State` means, with respect to a Market, that it is not in a Fixed Term State as a result of (i) the Market having been initially deployed as Open Term, or (ii) the term to maturity of the Fixed Term State specified in the Term Sheet having elapsed.

`Penalty APR` means the additional interest rate to be paid in addition to the Base APR that is applied if the Market is Delinquent for longer than the Grace Period.

`Protocol` means the Wildcat Protocol, as defined by https://docs.wildcat.finance.

`Protocol Fee` means any additional fee – denominated in Assets – accruing to the Protocol itself, over and above the Base APR and/or Penalty APR due to the Lenders.

`Reserve Ratio` means the percentage of the Market Token Supply of the Market as a whole that must be kept in the Market in the form of Equivalent Assets.

`Risk Disclosure Statement` means the risk disclosure statement, as may be amended from time to time, set out at https://docs.wildcat.finance/legal/risk-disclosure-statement and any risk disclosure statement made available from time to time through the Website.

`Role Provider` means, with respect to a Market, an Ethereum smart contract or Wallet Address deployed or controlled by the Borrower which sets forth a Lender Check Process, the successful completion of which grants a Lender a Deposit Credential.

`Sanctions Escrow` means, with respect to a Market, a smart contract deployed by the Sentinel to hold the Equivalent Loaned Assets associated with Lender in the event that their Wallet Address is marked as sanctioned by the Chainalysis Sanctions Screening Oracle, as further detailed in Section 13.

`Sanctions Event` means, with respect to a Market, the presence of a Wallet Address on the Chainalysis Sanctions Screening Oracle.

`Sentinel` means, with respect to a Market, a smart contract that determines whether a Wallet Address attempting to interact with the Protocol appears on the Chainalysis Sanctions Screening Oracle, either rejecting new Loans or creating escrow contracts to sever the existing Loan exposure of such Wallet Addresses, as further detailed in Section 13.

`Service Provider` means both Wildcat Foundation, a foundation incorporated under the laws of the Cayman Islands, and any affiliated entities, subsidiaries, or third-party service providers contracted by Wildcat Foundation.

`Specified Wallet Address` means the Ethereum Wallet Address of a Party notified to the other Party for the purposes of this Agreement.

`Term Sheet` means the term sheet attached hereto as Exhibit A as may be modified by the Borrower after the date hereof.

`Terms of Use` means the Wildcat Protocol Terms of Use accessible at https://docs.wildcat.finance/legal/wildcat-terms-of-use which sets out the terms and conditions under which the Parties access the Wildcat Protocol and use the Products provided by the Service Provider as further detailed in the Terms of Use, which Terms of Use has been agreed to by each of the Lender and the Borrower.

`Token Transferability` means, with respect to Market Tokens, the ability of the Lender to transfer to third party Wallet Addresses, which may be constrained by the Borrower on Market deployment to one of three options: (i) freely transferable, (ii) transferable only to Known Lenders or Wallet Addresses holding valid Deposit Credentials, or (iii) transferable only back to the Market during Withdrawals.

`Wallet Address` means a cryptographic public private key pair or string of unique characters associated with a virtual wallet which is used to send and receive virtual currency.

`Website` means https://app.wildcat.finance.

`Wildcat Protocol Documentation` means the Protocol documentation accessible at https://docs.wildcat.finance and the version of the Terms of Use accessible at https://docs.wildcat.finance/legal/wildcat-terms-of-use.

`Withdrawal` means the process of reclaiming Equivalent Loaned Assets from the Market as further detailed in Section 2(f).

### 2) General Loan Terms

#### a) General Loan Terms

Subject to the terms and conditions hereof, the Lender will make a Loan to the Borrower of the Assets specified on the Term Sheet and the Lender shall extend such Loan on the terms set forth on the Term Sheet.

The Borrower may, at any time, modify the terms of a Loan by amending the Market. Should the Lender not want to proceed with the Loan on the terms of such amendments, the Lender may exit the Market by requesting a Withdrawal, provided the Market is in an Open Term State.

#### b) Base APR Amendment

The Borrower may, at any time (subject to the constraints on increases and decreases laid out in the Wildcat Protocol Documentation), amend the Base APR of a Market in accordance with the terms of Section 2(a).

#### c) Amount of Digital Asset To Be Loaned Amendment

The Borrower may, at any time, amend the Amount of Digital Asset To Be Loaned in accordance with the terms of Section 2(a).

#### d) Minimum Deposit Amendment

The Borrower may, at any time, amend the Minimum Deposit amount in accordance with the terms of Section 2(a).

#### e) Fixed Term Maturity Amendment

The Borrower may, at any time (provided that the Market is currently in a Fixed Term state and the Fixed Term Maturity Reduction flag was enabled on Market deployment) amend the Fixed Term maturity to an earlier date, in accordance with the terms of Section 2(a).

#### f) Withdrawals

If the Lender is looking to reclaim Equivalent Loaned Assets from the Market, the Lender may request a Withdrawal via the Market while the latter is in an Open Term State, which Withdrawal may be in full or pro rata with other lenders depending on (i) the reserves of Assets in the Market at the time of the Withdrawal request and (ii) how many other lenders are simultaneously requesting a Withdrawal of such Assets.

#### g) Closing a Market

The Borrower may elect to close a Market by ensuring that sufficient Assets are deposited into the Market such that any lender, including the Lender, that submits a Withdrawal request will be able to reclaim all Equivalent Loaned Assets. Once a Market has been closed, interest will cease to accrue and no further amendments of the terms of the Loan or borrowing under the Market will be possible. The configuration of a Market may prevent its closure while it is in a Fixed Term State.

#### h) Termination of Loan

A Loan will terminate upon the earlier of:

(i) the Withdrawal by the Lender of all Equivalent Loaned Assets from the Market;

(ii) the closing of the Market by the Borrower;

(iii) the date notified by the non-defaulting Party to the Defaulting Party as the effective date of termination of the Loan upon the occurrence of an Event of Default as defined in Section 4 of this Agreement; provided that the non-defaulting Party shall have the right in its sole discretion to suspend the termination of a Loan under this subsection (iii) and reinstate the Loan. In the event of reinstatement of the Loan pursuant to this paragraph, the non-defaulting Party does not waive its right to terminate the Loan hereunder and the Event of Default shall be deemed to continue unless it is waived in writing by the non-defaulting Party; or

iv) the date notified by the Borrower where the Borrower considers, in its sole and reasonable discretion, that any activity conducted in connection with this Agreement could result in a breach of applicable law and regulation, including, but not limited to, any or all of the Loaned Assets becoming at risk of being considered a security, swap, derivative, or other similarly-regulated financial instrument or asset by any applicable regulatory authority or by any applicable court of law, dispute resolution organisation, arbitrator, or mediator.

#### i) Taxes and Fees

Neither the Borrower nor the Lender shall have any liability to the other Party for any taxes due under this Agreement.

### 3) Representations, Warranties and Covenants

The Parties hereby make the following representations and warranties, which shall continue during the term of this Agreement and any Loan hereunder:

a) Each Party represents and warrants that (i) it has the power to execute and deliver this Agreement, to enter into the Loans contemplated hereby and to perform its obligations hereunder, (ii) it has taken all necessary action to authorise such execution, delivery and performance, and (iii) this Agreement constitutes a legal, valid, and binding obligation enforceable against it in accordance with its terms;

b) Each Party hereto represents and warrants that it has not relied on the other for any tax or accounting advice concerning this Agreement and that it has made its own determination as to the tax and accounting treatment of any Loan, any Asset, or funds received or provided hereunder;

c) Each Party hereto represents and warrants that it is acting for its own account;

d) Each Party hereto represents and warrants that it is a sophisticated party and fully familiar with the inherent risks involved in the transaction contemplated in this Agreement, including, without limitation, risk of new financial regulatory requirements, potential loss of money and risks due to volatility of the price of the Loaned Assets, and voluntarily takes full responsibility for any risk to that effect;

e) Each Party represents and warrants that it is not insolvent and is not subject to any bankruptcy or insolvency proceedings under any Applicable Laws;

f) Each Party represents and warrants there are no proceedings pending or, to its knowledge, threatened, which could reasonably be anticipated to have any adverse effect on the transactions contemplated by this Agreement or the accuracy of the representations and warranties hereunder or thereunder;

g) The Lender represents and warrants that it has, or will have at the time of the transfer of any Loaned Assets, the right to transfer such Assets, subject to the terms and conditions hereof, and free and clear of all security, liens, charges, mortgages and encumbrances;

h) The Borrower represents and warrants that it has, or will have at the time of the transfer of any Assets (as Equivalent Loaned Assets), the right to transfer such Assets subject to the terms and conditions hereof, and free and clear of all security, liens, charges, mortgages and encumbrances other than those arising under this Agreement;

i) Each Party represents and warrants that it has all consents of any governmental or other authority that are required to be obtained by it with respect to this Agreement to which it is a Party and will use all reasonable efforts to maintain these in full force and effect, and obtain any that may become necessary in the future;

j) Each Party represents and warrants that it shall provide such information considered reasonably necessary to allow the other Party to conduct appropriate anti-money laundering and know your customer checks as may be required;

k) Each Party represents and warrants that, to the best of its knowledge and belief, no Assets, as Loaned Assets, are, or are related to, the proceeds of criminal activity;

l) Each Party represents and warrants that it has (i) undertaken sufficient due diligence regarding the Chainalysis Sanctions Screening Oracle (the `Oracle`) operation; (ii) understood that a Lender's Equivalent Loaned Assets may be transferred to a Sanctions Escrow contingent on a Sanctions Event; and (iii) agreed to bear all risks associated with potential Oracle errors or misdesignations, subject to the dispute resolution process outlined in Section 13 of this Agreement; and

m) Each Party represents and warrants that it has agreed to be bound by the terms and conditions of the Terms of Use;

### 4) Default

Any of the following events in respect of a Party (the `Defaulting Party`) shall constitute an event of default, and shall be herein referred to as an `Event of Default`:

a) the failure of the Borrower to return enough Equivalent Loaned Assets to honour a Lender's Withdrawal request such that the Penalty APR has applied for 90 days;

b) a material default by either Party in the performance of any provision of this Agreement, and a Party's failure to cure such material default within ten Business Days;

c) the commencement of any form of moratorium, creditor compromise, administration, bankruptcy, reorganisation, winding-up, liquidation or insolvency proceedings or actions (or other similar or equivalent proceedings or actions), or the taking of any steps by any party with a view to the commencement of aforementioned proceedings or actions in respect of either Party which are not dismissed within thirty (30) days of initiation of said proceedings;

d) any representation or warranty made by either Party in any of the Loan Documents that proves to be incorrect or untrue in any material respect as of the date of making or deemed making thereof; provided that a Party shall have ten (10) Business Days to cure such Event of Default; provided further that if a Borrower becomes insolvent such that the representation made by the Borrower in Section 3(e) is incorrect or untrue and such insolvency occurs as a result of the Borrower entering into the Loan or otherwise as a result of taking on credit through the Protocol, the Lender may agree that such incorrect or untrue representation shall not constitute an Event of Default under this Section 4(d).

### 5) Remedies

Upon the occurrence and during the continuation of any Event of Default by the Defaulting Party, the non-defaulting Party may, upon reasonable prior written notice to the Defaulting Party, at its option: (1) terminate this Agreement and any Loan hereunder; or (2) exercise all other rights and remedies available to such non-defaulting Party hereunder, under Applicable Law, or in equity. The Borrower shall determine or calculate any amounts hereunder at its sole reasonable discretion.

### 6) Limitations on Liability

a) In no event will either Party be liable to the other Party or any Third Party Beneficiary (as defined below) for any indirect, special, incidental, punitive or consequential Losses or damages (including, but not limited to, loss of profits, goodwill, reputation, loss of business opportunity or anticipated savings) arising out of or in connection with this Agreement, whether such liability arises from any claim based upon contract, warranty, tort (including negligence), strict liability or otherwise, and whether or not such party has been advised of the possibility of such loss or damage.

b) In no event will the Borrower be responsible or liable for any direct liabilities, costs, expenses, damages or Losses, including all interest, penalties and legal costs (calculated on a full indemnity basis) suffered by the Lender or any Third Party Beneficiary (as defined below) unless such damages or Losses directly result from the gross negligence, willful default or fraud of the Borrower.

c) Borrower shall not be deemed to have breached its obligations under this Agreement where such breach arises as a result of any event beyond its control, including but not limited to, technical failure, disruptions, downtime or outages of exchanges, blockchains, networks, custodial services or any other entity in the same or similar industry, acts of God, fire, flood, drought, earthquake or other natural disaster, epidemic or pandemic; terrorist attack, civil war, civil commotion or riots, war, threat of or preparation for war, armed conflict, imposition of sanctions, embargo, or breaking off of diplomatic relations; any law or any action taken by a regulatory or governmental authority; or any labour or trade dispute, strikes, industrial action or lockouts (other than in each case by the party seeking to rely on this clause, or companies in the same group as that party) (a `Force Majeure Event`). Borrower shall not be responsible, and shall have no liability to the Lender, for any direct or indirect Losses or damages incurred by the Lender for any failure by Borrower to perform its obligations under this Agreement if such performance is prevented, hindered or delayed by a Force Majeure Event. In these circumstances, Borrower's obligations will be suspended for as long as the Force Majeure Event continues or remains in effect.

d) Neither party will be liable for any Loss arising from any attack on the Protocol, including any such potential attacks as may be detailed in the Risk Disclosure Statement. For the avoidance of doubt, in no event shall the Service Provider be liable for any such Loss arising from any attack on the Protocol.

### 7) Alternative Arrangements in the Event of Loss of Wallet Address Access

It is possible that either Party may lose access to the Wallet Address through which they have engaged with the Market (a `Loss of Access`), with the result of such Loss of Access being the inability of such Party to engage with the Market to meet its obligations under this Agreement. If a Loss of Access occurs, the Parties agree to engage with each other to implement an alternative method for returning each other to the position they would be in had the Market been terminated by the Borrower at the time such Loss of Access was first communicated to the other Party via a Communication Platform.

### 8) Transfer of Title

Notwithstanding the use of expressions such as `loan`, which are used to reflect terminology used in the market for transactions of the kind provided for in this Agreement, all right, title and interest in and to the Assets transferred or paid under this Agreement (as Loaned Assets) shall pass to the Borrower upon transfer or payment, the obligation of the Borrower being an obligation to return Equivalent Assets. The Borrower shall be entitled to use the Assets transferred to it in any manner, including transferring such Assets to any account or wallet or for any other purpose.

In the event the Borrower is entitled to receive or receives any additional token(s) (the `Additional Tokens`) in connection with or arising from the Loaned Assets (including, but not limited to, an airdrop, ownership or possession of Loaned Assets, hard fork, or any other event) during the term of the Loan, the Borrower shall be deemed the sole and rightful owner of such Additional Tokens. The Lender acknowledges and agrees that all rights, title, and interest in and to such Additional Tokens shall vest in the Borrower, and such Additional Tokens shall not be considered part of the Loaned Assets subject to repayment obligations under this Agreement or the Term Sheet. For clarity, Additional Tokens refer solely to tokens received in addition to the Loaned Assets and do not include any Replacement Tokens (as defined below).

If the Borrower receives any tokens in substitution of or as replacement for the Loaned Assets (the `Replacement Tokens`) as a result of any event (including, but not limited to, a hard fork, protocol upgrade, or migration), the Borrower shall be deemed to have satisfied its obligation to repay the Loan under this Agreement to the extent the Borrower returns the Replacement Tokens as if they are, and in lieu of, the original Loaned Assets. For the avoidance of doubt, this shall not affect Borrower's ability to repay the Loan as otherwise specified under this Agreement or the Term Sheet.

### 9) Rights and Remedies Cumulative

No delay or omission by a Party in exercising any right or remedy hereunder shall operate as a waiver of the future exercise of that right or remedy or of any other rights or remedies hereunder, provided that upon the occurrence of an Event of Default such default shall be deemed waived if a Party does not begin exercising remedies with respect to such Event of Default within 30 days of notice of its occurrence. All rights of each Party stated herein are cumulative and in addition to all other rights provided by law, in equity.

### 10) Survival of Rights and Remedies

All remedies hereunder and all obligations with respect to any Loan shall survive the termination of the relevant Loan, return of Loaned Assets, and termination of this Agreement.

### 11) Governing Law; Dispute Resolution

This Agreement, and any non-contractual rights or obligations arising out of or in relation to it, is governed by, and shall be construed and enforced under the laws of England and Wales. The English courts shall have exclusive jurisdiction to settle any dispute (whether contractual or non-contractual and including a dispute relating to the existence, validity or termination of this Agreement) arising out of this Agreement.

Where the Lender or any Third Party Beneficiary, as may be relevant, is not established or located in England, it shall appoint an agent (a `Process Agent`) established in England or Wales and communicate the contact details of such agent to the Borrower to receive the service of any proceedings for or on its behalf in connection with or in relation to this Agreement. If for any reason such a Process Agent is unable to act as such, the Lender or the Third Party Beneficiary will promptly notify the Borrower and within 30 days appoint a substitute Process Agent acceptable to Borrower. The Lender or the Third Party Beneficiary, as may be relevant, agrees that if the Lender or such Third Party Beneficiary fails to appoint the Process Agent forthwith and in any event within 10 days of the execution of this Agreement, the Borrower may appoint a Process Agent for service of process on Lender or the Third Party Beneficiary. Lender or the Third Party Beneficiary, as may be relevant, shall be solely responsible for any costs associated with the appointment of its Process Agent by the Borrower. Nothing in this Agreement will affect the right of either Party to serve process in any other manner permitted by Applicable Law.

### 12) Third Party Beneficiaries

a) Per the implementation of the Protocol, the Market Tokens associated with a given Loan, which must be transferred back to the Market by a Lender in order to effect a Withdrawal, can be transferred by the Lender to any Wallet Address that is permitted by the Token Transferability level of the Market, which, for the avoidance of doubt, need not be a Specified Wallet Address.

b) This Agreement is enforceable in its entirety by any third party (a `Third Party Beneficiary`) which has ownership over a Wallet Address holding Market Tokens; provided that such Third Party Beneficiary successfully completes any Lender Check Processes as may be specified via Role Providers by the Borrower. For the avoidance of doubt, any Known Lender in possession of Market Tokens is capable of enforcing this Agreement in its entirety.

c) If a Third Party Beneficiary cannot clear or will not engage with such Lender Check Processes, such Third Party Beneficiary shall not be entitled to enforce any rights under this Agreement and may be prevented from initiating Withdrawals in accordance with the specific rules of the Market.

d) If a Third Party Beneficiary possesses Market Tokens that have been acquired through any event as contemplated as being within the scope of Section 6 of this Agreement, this Section 12 shall not apply to such Third Party Beneficiary and such Third Party Beneficiary shall have no right to enforce the terms of this Agreement.

Notwithstanding the foregoing, Third Party Beneficiary possessing such Market Tokens need not have acquired said Market Tokens directly from a Lender in order for this Section 12 to apply.

### 13) Treatment of Sanctioned Entities

a) All Markets deployed via the Protocol are monitored by a Chainalysis Sanctions Screening Oracle (the `Oracle`) via the Sentinel to determine whether Wallet Addresses are present on various sanctions designations such as those maintained by the US, EU and UN.

b) The Parties agree that the Oracle shall serve as the definitive source for determining whether any Wallet Address associated with a Party is subject to sanctions.

c) In the event that a Lender Wallet Address is sanctioned, the Sentinel will perform the following actions following the earlier of (i) the Lender attempting to make a Withdrawal, or (ii) the Borrower or any other third party triggering a removal function within the Market:

1. A Sanctions Escrow smart contract will be created,
2. The sanctioned Lender will be forced into an immediate Withdrawal request for the balance of their Market Tokens, and
3. The Equivalent Loaned Assets will not be returned to the Lender, but rather transferred to the Sanctions Escrow, whereupon they can be reclaimed by the Lender either (x) when the Lender Wallet Address is no longer subject to a Sanctions Event, or (y) if the Borrower explicitly overrides the sanction via the Market, which they may do if they determine the Oracle designation was erroneous.

e) In the event that a Lender disputes a Sanctions Event:

1. The burden of proof shall rest solely with the Lender to demonstrate, by clear and convincing evidence, that the Oracle's designation was erroneous;
2. The Lender must provide substantial evidence of their non-sanctioned status, which may include, but is not limited to:
   1. Documentation demonstrating ownership and control of the relevant Wallet Addresses;
   2. Evidence of the true beneficial owner of the Wallet Addresses in question; and
   3. Evidence showing the Oracle's designation conflicts with verifiable sanctions data.
3. Until such time as either (x) the Oracle removes the sanctions designation or (y) the Borrower explicitly overrides the sanction via the Market, all provisions in this Section 13 shall remain in full force and effect.

### 14) Third Party Rights

Except as otherwise stated under this Agreement, no term of this Agreement is enforceable by a person who is not a Party to this Agreement. The rights of the Parties to rescind or vary this Agreement are not subject to the consent of any other person.

### 15) Notices

Unless otherwise provided in this Agreement, all notices or demands relating to this Agreement shall be sent by a Communication Platform to the respective Party, as specified through the Website.

### 16) Variation, Assignment, Successors and Assigns

a) No variation of this Agreement shall be valid unless it is in writing and signed by or on behalf of each of the Parties.

b) This Agreement is binding on and inures to the benefit of the parties and their respective successors, heirs, personal representatives, and permitted assigns.

c) No Party may assign or delegate its rights or obligations hereunder without the prior written consent of the other Party, provided that the Borrower may assign or delegate its rights or obligations hereunder to an affiliate.

### 17) Single Agreement

The Borrower and the Lender acknowledge that, and have entered into this Agreement in reliance on the fact that, all Loans hereunder constitute a single business and contractual relationship and have been entered into in consideration of each other. Accordingly, the Borrower and the Lender hereby agree that payments, deliveries, and other transfers made by either of them in respect of any Loan shall be deemed to have been made in consideration of payments, deliveries, and other transfers in respect of any other Loan hereunder, and the obligations to make any such payments, deliveries and other transfers may be applied against each other and netted. In addition, the Borrower and the Lender acknowledge that, and have entered into this Agreement in reliance on the fact that, all Loans hereunder have been entered into in consideration of each other.

### 18) Entire Agreement

This Agreement and the Term Sheet constitutes the entire Agreement among the parties with respect to the subject matter hereof and supersede any prior negotiations, understandings and agreements with respect to the subject matter of this Agreement. Nothing in this Section 18 shall be construed to conflict with or negate Section 17 above.

### 19) Partial Invalidity

If any provision of this Agreement is or becomes or is found by a court or other competent authority to be illegal, invalid or unenforceable in any respect, in whole or in part, under any law of any jurisdiction, neither the legality, validity and enforceability in that jurisdiction of any other provision or part of this Agreement, nor the legality, validity or enforceability in any other jurisdiction of that provision or part or of any other provision of this Agreement, shall be affected or impaired.

### 20) Intention to be Bound

By clicking on the `Sign` (or similar) button, the Borrower and the Lender intend to be legally bound by the terms and conditions of this Agreement.

### 21) No Relationship

This Agreement does not create any kind of partnership, joint venture, fiduciary, agency or trustee relationship or any similar relationship or legal arrangement between the Parties or between either Party and any other person.

### 22) No Waiver

Save as otherwise agreed, the failure of or delay by either Party to enforce an obligation or exercise a right or remedy under any provision of this Agreement or to exercise any election in this Agreement shall not be construed as a waiver of such provision, and any such delay or failure to enforce, the waiver of, a particular obligation in one circumstance will not prevent such Party from subsequently requiring compliance with the obligation or exercising the right or remedy in the future. No waiver or modification by either Party of any provision of this Agreement shall be deemed to have been made unless expressed in writing and signed by both parties.

### 23) Termination of Agreement

In the event of a termination of this Agreement, any Loaned Assets shall be redelivered immediately, unless otherwise agreed to by the Parties, and any fees owed shall be payable immediately.

### 24) Miscellaneous

Whenever used herein, the singular number shall include the plural, the plural the singular, and the use of the masculine, feminine, or neuter gender shall include all genders where necessary and appropriate. The section headings are for convenience only and shall not affect the interpretation or construction of this Agreement. The Parties agree that none of the Agreement's provisions will be construed against the drafter.

***

## EXHIBIT A

### TERM SHEET

This term sheet (this `Term Sheet`) dated 2026-09-26, incorporates all the terms of the Master Loan Agreement (the `Agreement`) entered into by Demo MM Ltd (`Borrower`) and the individual or entity that has ownership of the Specified Wallet Address on the Chain ID mentioned herein (`Lender`) on 2026-09-26, and the following specific terms:

The following Loan shall be made by the Lender to the Borrower in accordance with the terms and mechanics of the Market, as set forth in the Wildcat Protocol Documentation. All terms used in this Term Sheet and not otherwise defined shall have the meaning ascribed to them in the Agreement or the Wildcat Protocol Documentation, as applicable.

**Market Address**: to be assigned on deployment

**Digital Asset To Be Loaned**: mUSDC (mock USD Coin, 6 decimals)

**Maximum Amount of Digital Asset To Be Loaned**: 20,000,000 mUSDC

**Base APR**: 10.00%

**Penalty APR**: 10.00%

**Minimum Reserve Ratio**: 20.00%

**Withdrawal Cycle Duration**: 7 days

**Maximum Grace Period Duration**: 3 days

**Minimum Deposit Amount**: 100,000 mUSDC

**Loan Type**: Open Term

**Fixed Term Maturity**: not applicable

**Early Fixed Term Closure Enabled**: not applicable

**Fixed Term Maturity Reduction Enabled**: not applicable

**Market Token Transferability**: transferable only to Known Lenders or Wallet Addresses holding valid Deposit Credentials

**Chain ID**: 11155111

**Chainalysis Sanctions Screening Oracle**: to be assigned on deployment

**Loan Effective Date**: 2026-09-26

The Lender hereby acknowledges that it is aware that the Base APR, Maximum Amount of Digital Asset To Be Loaned, Minimum Deposit Amount and Fixed Term Maturity (if applicable) can be adjusted by the Borrower in accordance with Section 2 of the Agreement. The Lender further acknowledges that if the Market is in a Fixed Term State, no Withdrawal requests will be processed until the earlier of i) the maturity specified above elapsing since the deployment of the Market, ii) the maturity being reduced by the Borrower to a period which has elapsed, or iii) the Market being terminated by the Borrower.

Borrower: Demo MM Ltd

Borrower Wallet: to be assigned on deployment

Signed By: ECDSA Signature

Specified Wallet Address: the Lender's wallet

Signed By: ECDSA Signature
