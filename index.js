const { Connection, PublicKey } = require("@solana/web3.js");
const { Token, TOKEN_PROGRAM_ID } = require("@solana/spl-token");
const readline = require("readline");
const axios = require("axios");
const { u64 } = require("@solana/buffer-layout-utils");
const { struct, u8, u32 } = require("@solana/buffer-layout");
const BN = require("bn.js");
const { BigNumber } = require("bignumber.js");
const TelegramBot = require("node-telegram-bot-api");

const token = "7551227549:AAGVevYLFxtNSsykPvwR4gSNagBm5eCfRwA";
let chatId = "-4766203625";
// Create a bot that uses 'polling' to fetch new updates
const bot_username = "@SolanaInspector_bot";

const bot = new TelegramBot(token, { polling: true });
let tnx_lookup_no = 2;
async function sendTelegramMessage(message, maxRetries = 5) {
  const encodedMessage = encodeURIComponent(message);
  const API_URL =
    "https://api.telegram.org/bot" +
    token +
    "/sendMessage?chat_id=" +
    chatId +
    "&text=" +
    encodedMessage;

  let retries = 0;

  while (retries < maxRetries) {
    try {
      const response = await axios.get(API_URL, {
        timeout: 20000,
      });

      if (response.data && response.data.ok) {
        console.log("Telegram message sent successfully");
        return response.data;
      } else {
        console.log(
          "Telegram API returned unsuccessful response:",
          response.data
        );
        retries++;
        // Wait a bit before retrying (exponential backoff)
        await new Promise((resolve) => setTimeout(resolve, 1000 * retries));
      }
    } catch (error) {
      console.log(
        `Telegram message error (attempt ${retries + 1}/${maxRetries}):`,
        error.message
      );
      retries++;

      // Wait a bit before retrying (exponential backoff)
      if (retries < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * retries));
      }
    }
  }

  console.log("Failed to send Telegram message after maximum retries");
  return null;
}

class TokenMonitor {
  constructor(rpcEndpoint, tokenMint, targetWallet, maxDepth = 3) {
    this.connection = new Connection(rpcEndpoint, "confirmed");
    this.tokenMint = new PublicKey(tokenMint);
    this.targetWallet = new PublicKey(targetWallet);
    this.maxDepth = maxDepth;
    this.lastSignature = null;
    this.checkedSignatures = new Set();
    this.walletCache = new Map();
    this.txFundingAccountsCache = new Map();
    this.organicBuyerList = [];
    this.tnxNo = 0;
    this.stackedWallets = new Set();
    this.totMint = 0;
    this.minAmountthreshold = 0.1;
  }

  async startMonitoring() {
    await this.checkNewTransactions();

    setInterval(async () => {
      try {
        await this.checkNewTransactions();
      } catch (error) {
        console.error("Monitoring error:", error);
      }
    }, 5000);
  }

  async checkNewTransactions() {
    const transactions = await this.connection.getSignaturesForAddress(
      this.tokenMint,
      {
        until: this.lastSignature,
        limit: 2,
      }
    );

    if (transactions.length === 0) {
      console.log("No new transactions found");
      return;
    }
    this.lastSignature = transactions[0].signature;

    for (const tx of transactions) {
      const parsedTx = await this.connection.getParsedTransaction(
        tx.signature,
        {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0, // Add this parameter
        }
      );

      await this.processTransaction(parsedTx);
    }
  }

  async processTransaction(parsedTx) {
    try {
      console.log("processTransaction....");

      const buyerWallet = await this.detectTokenBuy(parsedTx);
      if (buyerWallet) {
        console.log("********Buy transaction detected in logs");
        const isFunded = await this.checkFundingSource(
          buyerWallet,
          this.targetWallet,
          0
        );
        if (isFunded) {
          console.log("***************funding source in-organic wallet*******");
        } else {
          let solBalanceChange = 0;

          //000000000000000000000000000
          const preTokenBalances = parsedTx?.meta?.preTokenBalances;
          const postTokenBalances = parsedTx?.meta?.postTokenBalances;
          const accountKeys = parsedTx?.transaction.message.accountKeys;

          if (!preTokenBalances || !postTokenBalances || !accountKeys) {
            return null;
          }
          const rows = this.generateTokenBalanceRows(
            preTokenBalances,
            postTokenBalances,
            accountKeys
          );

          if (rows.length < 1) {
            return null;
          }
          rows.forEach((row) => {
            row.change = this.BalanceDelta({ delta: row.delta });
          });

          //each row covert account public key to string
          rows.forEach((row) => {
            row.account = row.account.toString();
          });

          // Find rows that match our token mint
          const targetTokenRow = rows.find(
            (row) => row.mint === this.tokenMint.toString() && row.change > 0
          );
          console.log(" token rows:", targetTokenRow);
          if (!targetTokenRow) {
            return null;
          }
          const accountRows = parsedTx?.transaction.message.accountKeys.map(
            (account, index) => {
              const pre = parsedTx.meta.preBalances[index];
              const post = parsedTx.meta.postBalances[index];
              const pubkey = account.pubkey;
              const key = account.pubkey.toBase58();
              const delta = new BigNumber(post).minus(new BigNumber(pre));

              return {
                pubkey,
                key,
                pre,
                post,
                delta,
                signer: account.signer,
                writable: account.writable,
              };
            }
          );
          //add new change field in each row by calling balance delta function
          accountRows.forEach((row) => {
            row.change = this.BalanceDelta({ delta: row.delta, isSol: true });
          });
          // Find row where signer is spending SOL (negative balance change)
          const tnx_signer = accountRows.find(
            (row) => row.signer && row.writable
          );
          try {
            if (true) {
              // Check if token account owner is the same as transaction signer

              const solamount = Math.abs(parseFloat(tnx_signer.change)) / 1e9;
              this.totMint += solamount;

              let isExistingBuyer = this.organicBuyerList.find(
                (buyer) => buyer.wallet === buyerWallet
              );
              //update organicBuyerList if wallet exist

              if (isExistingBuyer) {
                this.organicBuyerList.forEach((buyer) => {
                  if (buyer.wallet === buyerWallet) {
                    buyer.amount += solamount;
                  }
                });
              } else {
                //add other fieds
                this.organicBuyerList.push({
                  wallet: buyerWallet,
                  amount: solamount,
                });
              }
              isExistingBuyer = this.organicBuyerList.find(
                (buyer) => buyer.wallet === buyerWallet
              );
              const message = `🔄 Token bought:
📊 PNL: ${this.totMint}
------------ Wallet Info ------------
💰 Total SOL bought by Wallet = ${isExistingBuyer.amount} 
✅ swap:${solamount} SOL →  ${targetTokenRow.change} tokens 
👛 Buyer: ${buyerWallet}
                      `;

              // this.organicBuyerList.sort((a, b) => b.amount - a.amount);

              try {
                if (solamount > this.minAmountthreshold) {
                  sendTelegramMessage(message);
                }
                return;
              } catch (error) {
                console.log("Error in sending telegram message", error);
                return;
              }
            }
          } catch (error) {
            // Method 1: Calculate total SOL balance change for buyer
            const buyerIndex =
              parsedTx.transaction.message.accountKeys.findIndex(
                (account) => account.pubkey.toString() === buyerWallet
              );

            if (
              buyerIndex !== -1 &&
              parsedTx.meta.preBalances &&
              parsedTx.meta.postBalances
            ) {
              const preBal = parsedTx.meta.preBalances[buyerIndex];
              const postBal = parsedTx.meta.postBalances[buyerIndex];
              solBalanceChange = (preBal - postBal) / 1e9; // Convert lamports to SOL

              // Subtract transaction fee (paid by fee payer, which may be buyer)
              const feePayerIndex =
                parsedTx.transaction.message.accountKeys.findIndex(
                  (account) =>
                    account.signer === true && account.writable === true
                );

              if (feePayerIndex === buyerIndex && parsedTx.meta.fee) {
                solBalanceChange -= parsedTx.meta.fee / 1e9;
              }
              if (solBalanceChange <= 0) {
                return;
              }
              console.log(
                `Wallet ${buyerWallet} bought tokens for ${solBalanceChange} SOL`
              );

              this.organicBuyerList.push({
                wallet: buyerWallet,
                amount: solBalanceChange,
              });
              this.totMint += solBalanceChange;
              const message = `Total sol bought = ${this.totMint} \nWallet ${buyerWallet} bought tokens for ${solBalanceChange} SOL`;
              try {
                sendTelegramMessage(message);
              } catch (error) {
                console.log("error in sending telegram message", error);
              }
            }
          }
          return;
          //0000000000000
        }
        console.log(`----Wallet ${buyerWallet} funded by target: ${isFunded}`);
      }
    } catch (error) {
      console.error("Transaction processing error:", error.message);
    }
  }

  BalanceDelta({ delta, isSol = false }) {
    let sols;

    if (isSol) {
      sols = Math.abs(delta.toNumber());
    }

    if (delta.gt(0)) {
      return isSol ? sols : delta.toString();
    } else if (delta.lt(0)) {
      return isSol ? -sols : delta.toString();
    }

    return 0;
  }

  async detectTokenBuy(parsedTx) {
    try {
      const accountRows = parsedTx?.transaction.message.accountKeys.map(
        (account, index) => {
          const pre = parsedTx.meta.preBalances[index];
          const post = parsedTx.meta.postBalances[index];
          const pubkey = account.pubkey;
          const key = account.pubkey.toBase58();
          const delta = new BigNumber(post).minus(new BigNumber(pre));

          return {
            pubkey,
            key,
            pre,
            post,
            delta,
            signer: account.signer,
            writable: account.writable,
          };
        }
      );
      //add new change field in each row by calling balance delta function
      accountRows.forEach((row) => {
        row.change = this.BalanceDelta({ delta: row.delta, isSol: true });
      });
      // Find row where signer is spending SOL (negative balance change)
      const buyerRow = accountRows.find(
        (row) =>
          row.signer &&
          row.writable &&
          this.BalanceDelta({ delta: row.delta }) < 0
      );

      // Then check if a buyer was found
      const isBuy = !!buyerRow;

      // Get buyer wallet if found
      const buyerWallet = buyerRow ? buyerRow.key : null;

      console.log("Buyer wallet:", buyerWallet);

      if (isBuy) {
        return buyerWallet;
      } else {
        const maker = accountRows.find((row) => row.signer && row.writable);
        //its sell tnx if sol amount is greater than threshold than send it to telegram
        const solamount = Math.abs(parseFloat(maker?.change)) / 1e9;

        this.totMint = this.totMint - solamount;

        let isExistingBuyer = this.organicBuyerList.find(
          (buyer) => buyer.wallet === maker?.key
        );
        //update organicBuyerList if wallet exist

        if (!isExistingBuyer) {
          return null;
        }
        this.organicBuyerList.forEach((buyer) => {
          if (buyer.wallet === maker?.key) {
            buyer.amount -= solamount;
          }
        });

        if (solamount > this.minAmountthreshold) {
          const message = `🔄 Token sold:
📊 PNL: ${this.totMint}
------------ Wallet Info ------------
💰 Total SOL by Wallet = ${isExistingBuyer.amount}
✅ Sold:${solamount}
👛 Wallet: ${maker.key}
                      `;
          try {
            sendTelegramMessage(message);
          } catch (error) {
            console.log("Error in sending telegram message", error);
          }
        }
      }
      //000000000000000000000000000
    } catch (error) {
      console.error("Token buy detection error:", error.message);
      return this.checkBuyInstructionInLogs(parsedTx);
    }
  }
  checkBuyInstructionInLogs(parsedTx) {
    if (!parsedTx?.meta?.logMessages) {
      console.warn("Transaction logs are missing. tnx", parsedTx);

      return null;
    }

    console.log("Checking logs for buy instruction", parsedTx);

    const isBuyTransaction = parsedTx.meta.logMessages.some((log) =>
      log.includes("Instruction: Buy")
    );

    if (isBuyTransaction) {
      if (
        parsedTx.transaction.version == undefined ||
        parsedTx.transaction.version == "Legacy" ||
        parsedTx.transaction.version == "0"
      ) {
        // For legacy transactions, extract the signers manually

        const signer = parsedTx.transaction.message.accountKeys.find(
          (account) => account.signer == true
        );
        return signer.pubkey.toString();
      } else {
        // For version 0, 1, and 2, you can directly access signers
        const signer = parsedTx.transaction.message.accountKeys.find(
          (account) => account.isSigner == true
        );
        return signer.pubkey.toString();
      }
    }
  }
  generateTokenBalanceRows(preTokenBalances, postTokenBalances, accounts) {
    const preBalanceMap = {};
    const postBalanceMap = {};

    preTokenBalances.forEach(
      (balance) => (preBalanceMap[balance.accountIndex] = balance)
    );
    postTokenBalances.forEach(
      (balance) => (postBalanceMap[balance.accountIndex] = balance)
    );

    // Check if any pre token balances do not have corresponding
    // post token balances. If not, insert a post balance of zero
    // so that the delta is displayed properly
    for (const index in preBalanceMap) {
      const preBalance = preBalanceMap[index];
      if (!postBalanceMap[index]) {
        postBalanceMap[index] = {
          accountIndex: Number(index),
          mint: preBalance.mint,
          uiTokenAmount: {
            amount: "0",
            decimals: preBalance.uiTokenAmount.decimals,
            uiAmount: null,
            uiAmountString: "0",
          },
        };
      }
    }

    const rows = [];

    for (const index in postBalanceMap) {
      const { uiTokenAmount, accountIndex, mint } = postBalanceMap[index];
      const preBalance = preBalanceMap[accountIndex];
      const account = accounts[accountIndex].pubkey;

      if (!uiTokenAmount.uiAmountString) {
        // uiAmount deprecation
        continue;
      }

      // case where mint changes
      if (preBalance && preBalance.mint !== mint) {
        if (!preBalance.uiTokenAmount.uiAmountString) {
          // uiAmount deprecation
          continue;
        }

        rows.push({
          account: accounts[accountIndex].pubkey,
          accountIndex,
          balance: {
            amount: "0",
            decimals: preBalance.uiTokenAmount.decimals,
            uiAmount: 0,
          },
          delta: new BigNumber(-preBalance.uiTokenAmount.uiAmountString),
          mint: preBalance.mint,
        });

        rows.push({
          account: accounts[accountIndex].pubkey,
          accountIndex,
          balance: uiTokenAmount,
          delta: new BigNumber(uiTokenAmount.uiAmountString),
          mint: mint,
          change: 0,
        });
        continue;
      }

      let delta;

      if (preBalance) {
        if (!preBalance.uiTokenAmount.uiAmountString) {
          // uiAmount deprecation
          continue;
        }

        delta = new BigNumber(uiTokenAmount.uiAmountString).minus(
          preBalance.uiTokenAmount.uiAmountString
        );
      } else {
        delta = new BigNumber(uiTokenAmount.uiAmountString);
      }

      rows.push({
        account,
        accountIndex,
        balance: uiTokenAmount,
        delta,
        mint,
        change: 0,
      });
    }

    return rows.sort((a, b) => a.accountIndex - b.accountIndex);
  }
  async checkFundingSource(wallet, target, currentDepth) {
    if (currentDepth > this.maxDepth) return false;

    if (this.walletCache.has(wallet)) {
      console.log(`Cache hit for ${wallet}`);
      return this.walletCache.get(wallet);
    }

    console.log(
      `Checking funding for ${wallet} at depth ${currentDepth} for tnxNo: ${this.tnxNo}`
    );

    // Check direct funding
    const accountInfo = await this.connection.getAccountInfo(
      new PublicKey(wallet),
      "finalized"
    );

    if (accountInfo?.owner.equals(target)) {
      this.walletCache.set(wallet, true);
      return true;
    }

    // Check transaction history
    const signatures = await this.connection.getSignaturesForAddress(
      new PublicKey(wallet),
      {
        limit: tnx_lookup_no,
      }
    );

    for (const { signature } of signatures) {
      let fundingSource = [];

      if (this.txFundingAccountsCache.has(signature)) {
        console.log(`Cache hit for related accounts to :${signature}`);
        fundingSource = this.txFundingAccountsCache.get(signature);
      } else {
        const tx = await this.connection.getParsedTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });

        // Analyze instruction
        if (!tx) continue;
        if (
          tx.transaction.version == undefined ||
          tx.transaction.version == "Legacy" ||
          tx.transaction.version == "0"
        ) {
          // For legacy transactions, extract the signers manually
          fundingSource = tx.transaction.message.accountKeys
            .filter((account) => account.signer == true)
            .map((account) => account.pubkey.toString());
        } else {
          // For version 0, 1, and 2, you can directly access signers
          fundingSource = tx.transaction.message.accountKeys
            .filter((account) => account.isSigner === true)
            .map((account) => account.pubkey.toString());
        }

        console.log("cache", signature.substring(0, 6), "---->", [
          fundingSource[0],
        ]);
        this.txFundingAccountsCache.set(signature, [fundingSource[0]]);
      }
      if (fundingSource.length === 0) {
        console.log("no funding source");
        return false;
      }

      console.log(" check ", fundingSource, "==", target.toString());
      if (fundingSource.includes(target.toString())) {
        console.log("***************funding source equal target");
        this.walletCache.set(wallet, true);
        return true;
      }

      // Recursive check

      if (fundingSource[0] && wallet !== fundingSource[0]) {
        if (
          await this.checkFundingSource(
            fundingSource[0],
            target,
            currentDepth + 1
          )
        ) {
          this.walletCache.set(wallet, true);
          return true;
        }
      }
    }

    this.walletCache.set(wallet, false);
    this.tnxNo++;
    return false;
  }

  reset() {
    this.lastSignature = null;
    this.checkedSignatures = new Set();
    this.organicBuyerList = [];
    this.tnxNo = 0;
    this.stackedWallets = new Set();
    this.totMint = 0;
  }

  async getStatus() {
    return {
      tokenMint: this.tokenMint.toString(),
      targetWallet: this.targetWallet.toString(),
      maxDepth: this.maxDepth,
      organicBuyers: this.organicBuyerList.length,
      totalSol: this.totMint,
    };
  }
}

let TOKEN_ADDRESS = "";
let TARGET_WALLET = "";
let MAX_DEPTH = 3;

//get through user input in terminal

// async function main() {
//   await prompt("\nEnter to start... ");
//   TOKEN_ADDRESS = await prompt("\nEnter token address: ");
//   console.log("TOKEN_ADDRESS", TOKEN_ADDRESS);
//   TARGET_WALLET = await prompt("Enter target wallet address: ");
//   console.log("TARGET_WALLET", TARGET_WALLET);
//   //tnx_lookup_no
//   const no_tnxs = await prompt("Enter tnx lookup no: ");
//   tnx_lookup_no = parseInt(no_tnxs);
//   console.log("tnx_lookup_no", tnx_lookup_no);
//   MAX_DEPTH = await prompt("Enter max depth: ");
//   console.log("MAX_DEPTH", MAX_DEPTH);
//   const monitor = new TokenMonitor(
//     "https://mainnet.helius-rpc.com/?api-key=3e4ffcec-50e3-4fc3-a900-d1023384015d",
//     TOKEN_ADDRESS,
//     TARGET_WALLET,
//     parseInt(MAX_DEPTH)
//   );
//   monitor.startMonitoring().catch(console.error);
// }
// async function main() {
//   bot.on("message", (msg) => {
//     const chatId = msg.chat.id;

//     // send a message to the chat acknowledging receipt of their message
//     bot.sendMessage(chatId, "Received your message");
//     monitor.startMonitoring().catch(console.error);
//   });

//   const monitor = new TokenMonitor(
//     // "https://solana-api.instantnodes.io/token-instant node",
//     "https://mainnet.helius-rpc.com/?api-key=3e4ffcec-50e3-4fc3-a900-d1023384015d",
//     "4K5xSNUc2TNs9Ge68KMU9yDPGp1SeqbL1xxCUGbjks3J",
//     "DhLPHfDofyck4MQ55hAwv18YmSpemtEpDkg9V1RRGX74",
//     3 // Max depth
//   );
// }
// main().catch(console.error);
async function main() {
  let activeMonitor = null;
  let setupState = {};
  let isRunning = false;

  // Command handlers
  bot.onText(/\/start/, async (msg) => {
    const _chatId = msg.chat.id;

    // Reset the setup state
    setupState = {
      step: "token",
      tokenAddress: "",
      targetWallet: "",
      txLookupNo: 0,
      maxDepth: 0,
    };

    isRunning = false;
    if (activeMonitor) {
      // Stop any existing monitoring
      isRunning = false;
    }

    await bot.sendMessage(
      _chatId,
      "👋 Welcome to Solana Token Monitor!\n\n" +
        "I'll help you track token purchases and detect wallet relationships.\n\n" +
        "Please enter the token address you want to monitor:"
    );
    chatId = _chatId;
  });

  bot.onText(/\/stop/, async (msg) => {
    const chatId = msg.chat.id;

    if (isRunning && activeMonitor) {
      isRunning = false;
      await bot.sendMessage(
        chatId,
        "🛑 Monitoring stopped. Type /start to begin again."
      );
    } else {
      await bot.sendMessage(chatId, "⚠️ No active monitoring to stop.");
    }
  });

  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;

    if (isRunning && activeMonitor) {
      const status = `
🟢 Monitoring Active
📊 Token: ${activeMonitor.tokenMint.toString().slice(0, 8)}...
👥 Target: ${activeMonitor.targetWallet.toString().slice(0, 8)}...
🔍 Max Depth: ${activeMonitor.maxDepth}
💰 Total SOL: ${activeMonitor.totMint}
👛 Organic Buyers: ${activeMonitor.organicBuyerList.length}
⏱️ Running since: ${new Date().toLocaleTimeString()}
`;
      await bot.sendMessage(chatId, status);
    } else {
      await bot.sendMessage(
        chatId,
        "⚪ Monitoring is currently inactive. Type /start to begin."
      );
    }
  });

  bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;

    const helpText = `
📖 *Solana Token Monitor Bot Commands*

/start - Start the setup process and begin monitoring
/stop - Stop the current monitoring session
/status - Show current monitoring status
/help - Show this help message

*During setup, you will need to provide:*
1. Token address to monitor
2. Target wallet to check for relationship
3. Number of transactions to look back
4. Maximum relationship depth to check

For any issues, contact the administrator.
`;
    await bot.sendMessage(chatId, helpText, { parse_mode: "Markdown" });
  });

  // Handle regular messages (for setup process)
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return; // Ignore commands, handled above

    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // If we're in setup process
    if (setupState.step) {
      switch (setupState.step) {
        case "token":
          try {
            // Validate token address
            new PublicKey(text);
            setupState.tokenAddress = text;
            setupState.step = "wallet";
            await bot.sendMessage(
              chatId,
              "✅ Token address received.\n\n" +
                "Now enter the target wallet address to monitor for relationships:"
            );
          } catch (error) {
            await bot.sendMessage(
              chatId,
              "❌ Invalid token address. Please enter a valid Solana address:"
            );
          }
          break;

        case "wallet":
          try {
            // Validate wallet address
            new PublicKey(text);
            setupState.targetWallet = text;
            setupState.step = "txLookup";
            await bot.sendMessage(
              chatId,
              "✅ Target wallet received.\n\n" +
                "How many transactions should I look back for each wallet? (3-10 recommended) max 1000:"
            );
          } catch (error) {
            await bot.sendMessage(
              chatId,
              "❌ Invalid wallet address. Please enter a valid Solana address:"
            );
          }
          break;

        case "txLookup":
          const txNum = parseInt(text);
          if (isNaN(txNum) || txNum < 1 || txNum > 1000) {
            await bot.sendMessage(
              chatId,
              "❌ Please enter a valid number between 1 and 1000:"
            );
            return;
          }

          setupState.txLookupNo = txNum;
          setupState.step = "maxDepth";
          await bot.sendMessage(
            chatId,
            "✅ Transaction lookback set to " +
              txNum +
              ".\n\n" +
              "Finally, enter the maximum relationship depth to check (1-5 recommended max 10):"
          );
          break;

        case "maxDepth":
          const depth = parseInt(text);
          if (isNaN(depth) || depth < 1 || depth > 10) {
            await bot.sendMessage(
              chatId,
              "❌ Please enter a valid depth between 1 and 10:"
            );
            return;
          }

          setupState.maxDepth = depth;
          setupState.step = null; // End of setup

          // Update global settings
          tnx_lookup_no = setupState.txLookupNo;

          // Start monitoring
          await bot.sendMessage(
            chatId,
            "✅ Setup complete! Starting monitoring with:\n\n" +
              `Token: ${setupState.tokenAddress}...\n` +
              `Target: ${setupState.targetWallet}...\n` +
              `Tx Lookup: ${setupState.txLookupNo}\n` +
              `Max Depth: ${setupState.maxDepth}\n\n` +
              "Monitoring is now active. You'll receive notifications for token buys.\n" +
              "Type /stop to end monitoring."
          );

          // Create and start monitor
          try {
            activeMonitor = new TokenMonitor(
              "https://mainnet.helius-rpc.com/?api-key=3e4ffcec-50e3-4fc3-a900-d1023384015d",
              setupState.tokenAddress,
              setupState.targetWallet,
              setupState.maxDepth
            );

            isRunning = true;
            activeMonitor.startMonitoring().catch((error) => {
              console.error("Monitoring error:", error);
              bot.sendMessage(
                chatId,
                "⚠️ Error in monitoring: " + error.message
              );
              isRunning = false;
            });
          } catch (error) {
            console.error("Setup error:", error);
            bot.sendMessage(
              chatId,
              "⚠️ Error creating monitor: " + error.message
            );
          }
          break;
      }
    }
  });

  // Set up interval to check if monitoring should be active
  setInterval(() => {
    if (activeMonitor && !isRunning) {
      // If monitor exists but isRunning is false, stop checking for new transactions
      console.log("Monitoring paused");
    }
  }, 5000);

  console.log("Telegram bot started...");

  // Update the checkNewTransactions method in TokenMonitor class to respect the isRunning flag
  const originalCheckNewTransactions =
    TokenMonitor.prototype.checkNewTransactions;
  TokenMonitor.prototype.checkNewTransactions = async function () {
    if (!isRunning) {
      console.log("Monitoring is paused, skipping check");
      return;
    }

    return await originalCheckNewTransactions.call(this);
  };
}

main().catch(console.error);
