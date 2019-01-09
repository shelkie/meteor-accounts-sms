import Future from 'fibers/future';

var Codes = new Mongo.Collection('meteor_accounts_sms');
// Added index for phone number
Codes._ensureIndex('phone',
  {unique: 1});


Meteor.methods({
  'accounts-sms.sendVerificationCode': function (phone) {
    check(phone, String);

    return Accounts.sms.sendVerificationCode(phone);
  }
});

// Handler to login with a phone number and code.
Accounts.registerLoginHandler('sms', function (options) {
  if (!options.sms) return;

  check(options, {
    sms: Boolean,
    phone: MatchEx.String(1),
    code: MatchEx.String(1)
  });

    options.code = parseInt(options.code);

  return Accounts.sms.verifyCode(options.phone, options.code);
});

// Defaults accounts sms options
Accounts.sms.options = {
  verificationRetriesWaitTime: 10 * 60 * 1000,
  verificationWaitTime: 20 * 1000,
  verificationMaxRetryCounts: 5,
  verificationCodeLength: 4,
  // adminPhoneNumbers: [], Optional - fields for admin phone numbers - not doing phone validation
  // phoneVerificationMasterCode: XXXX, Optional - allow to define master code.
  phoneTemplate: {
    from: '+972545999999',  // Sample number
    text: function (code) {
      return 'Welcome your invitation code is: ' + code;
    }
  }
};


/**
 * You can set the twilio from, sid and key and this
 * will handle sending and verifying sms with twilio.
 * Or you can configure sendVerificationSms and verifySms helpers manually.
 * @param options
 * @param [options.twilio]
 * @param {String} options.twilio.from The phone number to send sms from.
 * @param {String} options.twilio.sid The twilio sid to use to send sms.
 * @param {String} options.twilio.token The twilio token to use to send sms.
 * @param {Function} [options.sendVerificationCode] (phone)
 * Given a phone number, send a verification code.
 * @param {Function} [options.verifyCode] (phone, code)
 * Given a phone number and verification code return the { userId: '' }
 * to log that user in or throw an error.
 */
Accounts.sms.configure = function (options) {
  check(options, Match.OneOf(
    {
      twilio: {
        from: String,
        sid: String,
        token: String
      }
    }, {
      lookup: MatchEx.Function(),
      sendVerificationCode: MatchEx.Function(),
      verifyCode: MatchEx.Function()
    }
  ));

  if (options.twilio) {
    Accounts.sms.client = new Twilio(options.twilio);
  } else {
    Accounts.sms.lookup = options.lookup;
    Accounts.sms.sendVerificationCode = options.sendVerificationCode;
    Accounts.sms.verifyCode = options.verifyCode;
  }
};

/**
 * Send a 4 digit verification sms with twilio.
 * @param phone
 */
Accounts.sms.sendVerificationCode = function (phone) {
  if (!Accounts.sms.client) throw new Meteor.Error('accounts-sms has not been configured');
  let lookup = null;
  try {
    lookup = Accounts.sms.client.lookup(phone); //{Type: 'carrier'} // Carrier info is not always accurate. Eg - some mobile lines appear as type: 'voip'
  }catch(err){
    throw new Meteor.Error(404, "Couldn't validate phone number");
  }

  if (lookup.carrier && lookup.carrier.type && lookup.carrier.type !== 'mobile') {
    throw new Meteor.Error(400, 'Not a mobile number');
  }

  // Make sure we're using the standard format
  phone = lookup.phone_number;


  // Check that haven't send too many verification codes
  let codeObj = Codes.findOne({phone: phone});
  let retryObject = (codeObj && codeObj.retry) || {numOfRetries: 0};

  // Check if last retry was too soon
  let smsOptions = Accounts.sms.options;
  const curTime = new Date();
  let nextRetryDate = retryObject && retryObject.lastRetry &&
    new Date(retryObject.lastRetry.getTime() + smsOptions.waitTimeBetweenRetries);
  if (nextRetryDate && nextRetryDate > curTime) {
    const waitTimeInSec = Math.ceil(Math.abs((nextRetryDate - curTime) / 1000)),
      errMsg = `SendVerificationCode: Too often retries, try again in ${waitTimeInSec} seconds.`;
    throw new Meteor.Error(errMsg);
  }
  // Check if there where too many retries
  if (retryObject.numOfRetries > smsOptions.verificationMaxRetryCounts) {
    // Check if passed enough time since last retry
    var waitTimeBetweenMaxRetries = smsOptions.verificationRetriesWaitTime;
    nextRetryDate = new Date(retryObject.lastRetry.getTime() + waitTimeBetweenMaxRetries);
    if (nextRetryDate > curTime) {
      var waitTimeInMin = Math.ceil(Math.abs((nextRetryDate - curTime) / 60000)),
        errMsg = `SendVerificationCode: Too many retries, try again in ${waitTimeInMin} minutes.`;
      throw new Error(errMsg);
    }
  }
  // Update retry obj
  retryObject.lastRetry = curTime;
  retryObject.numOfRetries++;

  let code = getRandomCode(smsOptions.verificationCodeLength);

  // Clear out existing codes
  Codes.remove({phone: phone});

  // Generate a new code.
  Codes.insert({phone: phone, code: code, retry: retryObject});

    let future = new Future();

  Accounts.sms.client.sendSMS({
    to: phone,
    from: smsOptions.phoneTemplate.from,
    body: smsOptions.phoneTemplate.text(code)
  }, function(err, result){
      if (err){
          logger.error('Twilio error:', err);
          future.return(err);
      }else{
          future.return(phone);
          //future.return(result);
      }
  });

    return future.wait();
};

/**
 * Verify that the given code is valid
 * @param phone
 * @param code
 */
Accounts.sms.verifyCode = function (phone, code) {

  // TODO add check for too many gueses per phone number
  var validCode = Codes.findOne({phone: phone, code: code});
  if (!validCode) throw new Meteor.Error('Invalid verification code');

  var user = Meteor.users.findOne({phone: phone}, {fields: {_id: 1}});
  if (!user){
      user = {};
      user._id = Meteor.users.insert({
          phone: phone,
          createdAt: new Date()
      });
  }

  // Clear the verification code after a successful login.
  Codes.remove({phone: phone});
  return {userId: user._id};
};


/****** Helper functions ****/

/**
 * Check whether the given code is the defined master code
 * @param code
 * @returns {*|boolean}
 */
var isMasterCode = function (code) {
  return code && Accounts.sms.options.phoneVerificationMasterCode &&
    code == Accounts.sms.options.phoneVerificationMasterCode;
};

/**
 * Get random phone verification code
 * @param length
 * @returns {string}
 */
var getRandomCode = function (length) {
  length = length || 4;
  // For length of 4 - powerLength = 1000
  let powerLength = Math.pow(10, length - 1);
  // For length of 4 - result = 9000 * Randon(0,1) + 1000;
  return Math.floor(Math.random() * 9 * powerLength) + powerLength;
};