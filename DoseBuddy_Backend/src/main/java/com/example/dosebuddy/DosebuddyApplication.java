package com.example.dosebuddy;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class DosebuddyApplication {

	public static void main(String[] args) {
		SpringApplication.run(DosebuddyApplication.class, args);
	}

}
