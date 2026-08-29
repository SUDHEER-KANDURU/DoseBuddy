package com.example.dosebuddy;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.mail.MailSenderAutoConfiguration;
import org.springframework.boot.autoconfigure.mail.MailSenderValidatorAutoConfiguration;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication(exclude = {
        MailSenderAutoConfiguration.class,
        MailSenderValidatorAutoConfiguration.class
})
@EnableScheduling
@EnableAsync
public class DosebuddyApplication {

	public static void main(String[] args) {
		SpringApplication.run(DosebuddyApplication.class, args);
	}

}
