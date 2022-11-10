#!/usr/bin/env node

const { execSync } = require('child_process')
const { program } = require('commander')
const https = require('https')
const ethers = require('ethers')
const flashbots = require('@flashbots/ethers-provider-bundle')
const prompt = require('prompt-sync')()
const fs = require('fs/promises')

program.option('-r, --rpc <url>', 'RPC endpoint URL', 'http://localhost:8545')
       .option('-d, --daemon <cmd>', 'command (+ args if req) to run the rocketpool smartnode daemon', 'docker exec rocketpool_node /go/bin/rocketpool')
       .option('-l, --salt <salt>', 'salt for custom minipool address')
       .option('-f, --max-fee <maxFee>', 'max transaction fee per gas in gwei')
       .option('-i, --max-prio <maxPrio>', 'max transaction priority fee per gas in gwei')
       .option('-x, --extra-args <args>', 'extra (space-separated) arguments to pass to daemon calls')
       .option('-n, --dry-run', 'simulate only, do not submit transaction bundle')
       .option('-v, --bundle-file <file>', 'filename for saving the bundle before submission or reading a saved bundle', 'bundle.json')
       .option('-e, --resume', 'do not create a new bundle, instead submit the one saved in the bundle file')
       .option('-o, --resume-deposit', 'do not create a new deposit, use the one saved in the bundle file; but recreate the arb transaction')
       .option('-p, --no-use-dp', 'do not include space in the deposit pool in the arb')
       .option('-m, --max-tries <m>', 'number of blocks to attempt to submit bundle for', 10)
       .option('-a, --amount <amt>', 'amount in ether to deposit', 16)
       .option('-c, --min-fee <com>', 'minimum minipool commission fee', .15)
       .option('-g, --gas-limit <gas>', 'gas limit for arbitrage transaction', 900000)
       .option('-u, --gas-refund <gas>', 'set min-profit to a gas refund of this much gas', 2500000)
       .option('-b, --arb-contract <addr>', 'deployment address of the RocketDepositArbitrage contract', '0x1f7e55F2e907dDce8074b916f94F62C7e8A18571')
       .option('-s, --slippage <percentage>', 'slippage tolerance for the arb swap', 2)
program.parse()
const options = program.opts()

console.log('Welcome to RocketArb: Deposit!')

if (!options.resume && !options.resumeDeposit) {
  var answer = prompt('Have you done a dry run of depositing your minipool using the smartnode? ')
  if (!(answer === 'y' || answer === 'yes')) {
    console.log('Do that first then retry.')
    process.exit()
  }
}

if (options.resume && options.resumeDeposit) {
  console.log('At most one of --resume and --resume-deposit may be given')
  process.exit()
}

const oneEther = ethers.utils.parseUnits("1", "ether")
const oneGwei = ethers.utils.parseUnits("1", "gwei")
const amountWei = oneEther.mul(options.amount)

const randomSigner = ethers.Wallet.createRandom()
const provider = new ethers.providers.JsonRpcProvider(options.rpc)

const wethAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

function getDepositTx() {
  var cmd = options.daemon
  if (options.maxFee) cmd = cmd.concat(' --maxFee ', options.maxFee)
  if (options.maxPrio) cmd = cmd.concat(' --maxPrioFee ', options.maxPrio)
  if (options.extraArgs) cmd = cmd.concat(' ', options.extraArgs)
  const salt = options.salt ? parseInt(options.salt, 16) : Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)

  cmd = cmd.concat(' api node deposit ',
    ethers.utils.formatUnits(amountWei, "wei"),
    ' 0.15 ',
    salt.toString(),
    ' false')

  console.log(`Creating deposit transaction by executing smartnode: ${cmd}`)

  const cmdOutput = execSync(cmd)
  const encodedSignedDepositTx = `0x${cmdOutput.toString().trim()}`
  // console.log(`Got tx: ${encodedSignedDepositTx}`)
  console.log(`Got deposit transaction data from smartnode`)
  return encodedSignedDepositTx
}

async function getAmounts(amount) {
  const rocketStorageAddress = '0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46'
  const rocketStorage = new ethers.Contract(
    rocketStorageAddress, ["function getAddress(bytes32 key) view returns (address)"], provider)
  const rethAddress = await rocketStorage.getAddress(
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes("contract.addressrocketTokenRETH")))
  const rethContract = new ethers.Contract(
    rethAddress, ["function getRethValue(uint256 ethAmount) view returns (uint256)"], provider)
  const rocketDepositSettingsAddress = await rocketStorage.getAddress(
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes("contract.addressrocketDAOProtocolSettingsDeposit")))
  const depositSettings = new ethers.Contract(
    rocketDepositSettingsAddress, ["function getDepositFee() view returns (uint256)",
                                   "function getMaximumDepositPoolSize() view returns (uint256)"], provider)
  const rocketDepositPoolAddress = await rocketStorage.getAddress(
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes("contract.addressrocketDepositPool")))
  const rocketDepositPool = new ethers.Contract(
    rocketDepositPoolAddress, ["function getBalance() view returns (uint256)"], provider)
  const dpFee = await depositSettings.getDepositFee()
  const dpSize = await depositSettings.getMaximumDepositPoolSize()
  const dpSpace = dpSize.sub(await rocketDepositPool.getBalance())
  const ethAmount = options.useDp ? amount.add(dpSpace) : amount
  const depositFee = ethAmount.mul(dpFee).div(oneEther)
  const depositAmount = ethAmount.sub(depositFee)
  const rethAmount = await rethContract.getRethValue(depositAmount)
  console.log(`Total rETH amount to swap: ${ethers.utils.formatUnits(rethAmount, 'ether')} ` +
              `(from ${ethers.utils.formatUnits(ethAmount, 'ether')} ETH deposit (${ethers.utils.formatUnits(depositAmount, 'ether')} after mint fee))`)
  return [ethAmount, rethAmount, rethAddress]
}

async function getSwapData(rethAmount, rethAddress) {
  const swapParams = new URLSearchParams({
    fromTokenAddress: rethAddress,
    toTokenAddress: wethAddress,
    fromAddress: options.arbContract,
    amount: rethAmount,
    slippage: options.slippage,
    allowPartialFill: false,
    disableEstimate: true
  }).toString()
  const url = `https://api.1inch.io/v4.0/1/swap?${swapParams}`
  const apiCall = new Promise((resolve, reject) => {
    const req = https.get(url,
      (res) => {
        if (res.statusCode !== 200) {
          console.log(`Got ${res.statusCode} from 1inch`)
          reject(res)
        }
        res.setEncoding('utf8')
        let data = ''
        res.on('data', (chunk) => data += chunk)
        res.on('end', () => resolve(JSON.parse(data)))
      })
    req.on('error', reject)
  })
  const swap = await apiCall
  if (ethers.utils.getAddress(swap.tx.to) !== '0x1111111254fb6c44bAC0beD2854e76F90643097d')
    console.log(`Warning: unexpected to address for swap: ${swap.tx.to}`)
  return swap.tx.data
}

async function getArbTx(encodedSignedDepositTx) {
  console.log('Creating arb transaction')

  const arbAbi = ["function arb(uint256 wethAmount, uint256 minProfit, bytes swapData) nonpayable"]
  const arbContract = new ethers.Contract(options.arbContract, arbAbi, provider)

  const signedDepositTx = ethers.utils.parseTransaction(encodedSignedDepositTx)
  const [ethAmount, rethAmount, rethAddress] = await getAmounts(signedDepositTx.value)
  const swapData = await getSwapData(rethAmount, rethAddress)
  const gasRefund = ethers.BigNumber.from(options.gasRefund)
  const minProfit = gasRefund.mul(signedDepositTx.maxFeePerGas)
  const unsignedArbTx = await arbContract.populateTransaction.arb(ethAmount, minProfit, swapData)
  unsignedArbTx.type = 2
  unsignedArbTx.chainId = signedDepositTx.chainId
  unsignedArbTx.nonce = signedDepositTx.nonce + 1
  unsignedArbTx.maxPriorityFeePerGas = signedDepositTx.maxPriorityFeePerGas
  unsignedArbTx.maxFeePerGas = signedDepositTx.maxFeePerGas
  unsignedArbTx.gasLimit = parseInt(options.gasLimit)

  // sign randomly first to get around go-ethereum unmarshalling issue
  const fakeSigned = await randomSigner.signTransaction(unsignedArbTx)
  cmd = options.daemon.concat(' api node sign ', fakeSigned.substring(2))
  const signOutput = JSON.parse(execSync(cmd))
  console.assert(signOutput.status === 'success', `signing arb transaction failed: ${signOutput.error}`)
  const encodedSignedArbTx = signOutput.signedData

  console.log('Signed arb transaction with smartnode')

  return encodedSignedArbTx
}

async function makeBundle() {
  const encodedSignedDepositTx = getDepositTx()
  /* verbose logging
  console.log('Deposit tx parses as')
  function ppTx(tx) {
    return [
      `hash:${tx.hash}`,
      `to:${tx.to}`,
      `from:${tx.from}`,
      `nonce:${tx.nonce}`,
      `gasLimit:${tx.gasLimit.toString()}`,
      `maxFeePerGas:${ethers.utils.formatUnits(tx.maxFeePerGas, "gwei")}`,
      `maxPriorityFeePerGas:${ethers.utils.formatUnits(tx.maxPriorityFeePerGas, "gwei")}`,
      `data:${tx.data}`,
      `value:${ethers.utils.formatUnits(tx.value, "ether")}`,
      `chainId:${tx.chainId}`].join('\n')
  }
  console.log(ppTx(ethers.utils.parseTransaction(encodedSignedDepositTx)))
  */
  const encodedSignedArbTx = await getArbTx(encodedSignedDepositTx)
  const bundle = [
    {signedTransaction: encodedSignedDepositTx},
    {signedTransaction: encodedSignedArbTx}
  ]
  console.log(`Saving bundle to ${options.bundleFile}`)
  await fs.writeFile(options.bundleFile, JSON.stringify(bundle))
  return bundle
}

async function retrieveBundle() {
  console.log(`Resuming with bundle from ${options.bundleFile}`)
  return JSON.parse(await fs.readFile(options.bundleFile, 'utf-8'))
}

async function retrieveDeposit() {
  console.log(`Resuming using deposit from ${options.bundleFile}`)
  const bundle = JSON.parse(await fs.readFile(options.bundleFile, 'utf-8'))
  bundle[1].signedTransaction = await getArbTx(bundle[0].signedTransaction)
  return bundle
}

;(async () => {

const bundle = await (options.resumeDeposit ? retrieveDeposit() :
                      options.resume ? retrieveBundle() : makeBundle())

console.log('waiting for network')
const network = await provider.getNetwork()
console.log(`got ${JSON.stringify(network)}`)
const flashbotsProvider = await flashbots.FlashbotsBundleProvider.create(
  provider, randomSigner, undefined, network.name)
console.log('created flashbotsProvider')

const currentBlockNumber = await provider.getBlockNumber()

if (options.dryRun) {
  console.log(`Dry run only: using flashbots simulate on one block`)
  const currentBlock = await provider.getBlock(currentBlockNumber)
  const currentBaseFeePerGas = currentBlock.baseFeePerGas
  console.log(`current base fee ${ethers.utils.formatUnits(currentBaseFeePerGas, 'gwei')} gwei`)
  const targetBlockNumber = currentBlockNumber + 1
  console.log(`Target block number: ${targetBlockNumber}`)
  const signedBundle = await flashbotsProvider.signBundle(bundle)
  const simulation = await flashbotsProvider.simulate(signedBundle, targetBlockNumber)
  console.log(JSON.stringify(simulation, null, 2))
  const bundlePricing = flashbotsProvider.calculateBundlePricing(simulation.results, currentBaseFeePerGas)
  console.log(JSON.stringify(bundlePricing, null, 2))
}
else {
  const maxTries = parseInt(options.maxTries)
  const targetBlockNumbers = []
  const promises = []
  for (let targetBlockNumber = currentBlockNumber + 1; targetBlockNumber <= currentBlockNumber + maxTries; targetBlockNumber++) {
    targetBlockNumbers.push(targetBlockNumber)
    promises.push(flashbotsProvider.sendBundle(bundle, targetBlockNumber))
  }
  const submissions = await Promise.all(promises)
  // const failures = []

  for (const [i, targetBlockNumber] of targetBlockNumbers.entries()) {
    const submission = submissions[i]
    const currentBaseFeePerGas = (await provider.getBlock(await provider.getBlockNumber())).baseFeePerGas
    console.log(`current base fee ${ethers.utils.formatUnits(currentBaseFeePerGas, 'gwei')} gwei`)
    console.log(`Target block number: ${targetBlockNumber}`)
    if ('error' in submission) {
      console.log(`RelayResponseError:\n${JSON.stringify(submission)}`)
    }
    else {
      const resolution = await submission.wait()
      console.log(`Resolution: ${flashbots.FlashbotsBundleResolution[resolution]}`)
      if (resolution === flashbots.FlashbotsBundleResolution.BlockPassedWithoutInclusion) {
        /*
        if (network.chainId === 1) {
          failures.push([submission, targetBlockNumber])
        }
        */
        continue
      }
      else {
        console.log('Bundle successfully included on chain!')
        process.exit(0)
      }
    }
  }
}

/* flashbots debugging (only possible on mainnet)
if (failures.length) {
  console.log('Bundle inclusion failed')
  console.log('User stats:')
  const userStats = await flashbotsProvider.getUserStats()
  console.log(JSON.stringify(userStats, null, 2))
  for (const [submission, targetBlockNumber] of failures) {
    const signedBundle = submission.bundleTransactions.map(a => a.signedTransaction)
    const conflictReport = await flashbotsProvider.getConflictingBundle(signedBundle, targetBlockNumber)
    console.log(`Conflict report for ${targetBlockNumber}: ${flashbots.FlashbotsBundleConflictType[conflictReport.conflictType]}`)
    console.log(JSON.stringify(conflictReport, null, 2))
  }
}
*/

})()
